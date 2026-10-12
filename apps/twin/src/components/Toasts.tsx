/**
 * 轻量提示（toast）：右下角浮层，支持 info / ok / err 三种语气。
 * 用法：const toast = useToast(); toast.ok('已保存');
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

type Tone = 'info' | 'ok' | 'err';

interface ToastItem {
  id: number;
  tone: Tone;
  text: string;
}

interface ToastApi {
  info: (text: string) => void;
  ok: (text: string) => void;
  err: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const push = useCallback((tone: Tone, text: string) => {
    seq.current += 1;
    const id = seq.current;
    setItems((prev) => [...prev, { id, tone, text }]);
    const ttl = tone === 'err' ? 5200 : 3200;
    setTimeout(() => {
      setItems((prev) => prev.filter((it) => it.id !== id));
    }, ttl);
  }, []);

  const api = useMemo<ToastApi>(() => ({
    info: (t) => push('info', t),
    ok: (t) => push('ok', t),
    err: (t) => push('err', t),
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts">
        {items.map((it) => (
          <div key={it.id} className={`toast${it.tone === 'err' ? ' err' : it.tone === 'ok' ? ' ok' : ''}`}>
            {it.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}
