/**
 * 鉴权上下文：token 持久化 + 401 自动刷新 + 统一调用包装。
 *
 * 设计要点：
 *   * token 存 localStorage（key: qz.auth），刷新页面不丢登录态
 *   * `authed(fn)` 统一处理：access_token 过期（code 1002）时自动用 refresh_token
 *     换一次新的 access_token 并重放原请求；refresh 也失败则清空登录态
 *   * 刷新采用「单飞」模式：并发请求同时 401 时只发一次 refresh
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import { ApiError, api, type TokenBundle } from './api';

const STORAGE_KEY = 'qz.auth';

export interface AuthUser {
  userId: number;
  email: string;
}

export interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, nickname?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** 包装需要鉴权的请求：自动带 token、自动刷新、失败时登出 */
  authed: <T>(fn: (token: string) => Promise<T>) => Promise<T>;
}

const AuthContext = createContext<AuthState | null>(null);

interface Stored {
  userId: number;
  email: string;
  accessToken: string;
  refreshToken: string;
}

function readStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Stored;
    if (!obj || !obj.accessToken || !obj.refreshToken) return null;
    return obj;
  } catch {
    return null;
  }
}

function writeStored(v: Stored | null) {
  try {
    if (v) localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可用，忽略 */
  }
}

function bundleToStored(b: TokenBundle): Stored {
  return {
    userId: b.user_id,
    email: b.email,
    accessToken: b.access_token,
    refreshToken: b.refresh_token,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Stored | null>(() => readStored());
  const [ready, setReady] = useState(false);

  // 用 ref 保存最新值，供 authed 闭包读取（避免闭包捕获旧值）
  const ref = useRef<Stored | null>(stored);
  ref.current = stored;

  // 单飞：同一时刻只允许一个 refresh 在途
  const refreshing = useRef<Promise<Stored | null> | null>(null);

  useEffect(() => {
    setReady(true);
  }, []);

  const persist = useCallback((v: Stored | null) => {
    ref.current = v;
    setStored(v);
    writeStored(v);
  }, []);

  const doRefresh = useCallback(async (): Promise<Stored | null> => {
    const cur = ref.current;
    if (!cur?.refreshToken) return null;
    if (refreshing.current) return refreshing.current;

    const task = (async () => {
      try {
        const b = await api.refresh(cur.refreshToken);
        const next = bundleToStored(b);
        persist(next);
        return next;
      } catch {
        persist(null);
        return null;
      } finally {
        refreshing.current = null;
      }
    })();

    refreshing.current = task;
    return task;
  }, [persist]);

  const login = useCallback(async (email: string, password: string) => {
    const b = await api.login(email, password);
    persist(bundleToStored(b));
  }, [persist]);

  const register = useCallback(async (email: string, password: string, nickname?: string) => {
    const b = await api.register(email, password, nickname);
    persist(bundleToStored(b));
  }, [persist]);

  const logout = useCallback(async () => {
    const cur = ref.current;
    persist(null);
    if (cur) {
      // 尽力而为地通知服务端吊销 refresh_token，失败不影响本地登出
      try {
        await api.logout(cur.accessToken, cur.refreshToken);
      } catch {
        /* ignore */
      }
    }
  }, [persist]);

  const authed = useCallback(async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
    const cur = ref.current;
    if (!cur) throw new ApiError(1002, '未登录');

    try {
      return await fn(cur.accessToken);
    } catch (e) {
      if (!(e instanceof ApiError) || !e.isAuthError) throw e;
      const next = await doRefresh();
      if (!next) throw new ApiError(1002, '登录已失效，请重新登录');
      return await fn(next.accessToken);
    }
  }, [doRefresh]);

  const value = useMemo<AuthState>(() => ({
    user: stored ? { userId: stored.userId, email: stored.email } : null,
    accessToken: stored?.accessToken ?? null,
    ready,
    login,
    register,
    logout,
    authed,
  }), [stored, ready, login, register, logout, authed]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 <AuthProvider> 内使用');
  return ctx;
}
