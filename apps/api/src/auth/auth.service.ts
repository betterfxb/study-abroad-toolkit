/**
 * 鉴权服务：注册 / 登录 / 刷新 / 登出（契约 §1）。
 *
 * - 密码用 bcrypt 哈希存储；
 * - access_token 2h，refresh_token 30d；
 * - refresh 采用轮换策略（旧 token 立即吊销），防重放。
 */

import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compareSync, hashSync } from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { BizError } from '../common/biz-error';
import { DatabaseService } from '../db/database.service';

export const ACCESS_TTL_SEC = 7200;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  nickname: string;
  role: string;
  created_at: string;
  updated_at: string;
}

function nowIso() {
  return new Date().toISOString();
}

export function isEmail(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

/**
 * 管理员白名单判定（纯函数，便于测试）。
 *
 * 管理员不做「注册后自助升级」——那等于把权限交给任意注册者。
 * 这里用部署期配置 `ADMIN_EMAILS`（逗号分隔，大小写不敏感）在**注册时**定角色，
 * 已存在的用户如需提升，由运维直接改库（一次性动作，不提供自助接口）。
 */
export function isAdminEmail(email: unknown, raw = process.env.ADMIN_EMAILS): boolean {
  if (typeof email !== 'string' || !raw) return false;
  const target = email.trim().toLowerCase();
  if (!target) return false;
  // 分隔符必须覆盖顿号「、」——界面与配置示例习惯用顿号，
  // 漏掉会让整串被当成一个地址而匹配不上（本项目已因此踩过一次：订阅关键词拆分）
  return String(raw)
    .split(/[,，、\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(target);
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DatabaseService,
    private readonly jwt: JwtService,
  ) {}

  private issue(user: UserRow) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwt.sign(payload, { expiresIn: ACCESS_TTL_SEC });
    const refreshToken = randomBytes(32).toString('hex');
    this.db.run(
      `INSERT INTO refresh_tokens(token, user_id, expires_at, revoked, created_at)
       VALUES (?, ?, ?, 0, ?)`,
      refreshToken,
      user.id,
      new Date(Date.now() + REFRESH_TTL_MS).toISOString(),
      nowIso(),
    );
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: ACCESS_TTL_SEC,
      token_type: 'Bearer',
    };
  }

  register(email: unknown, password: unknown, nickname = '') {
    if (!isEmail(email)) throw BizError.invalid('邮箱格式不正确');
    if (typeof password !== 'string' || password.length < 6) {
      throw BizError.invalid('密码至少 6 位');
    }
    if (this.db.get('SELECT id FROM users WHERE email = ?', email)) {
      throw BizError.invalid('该邮箱已注册');
    }

    const now = nowIso();
    const role = isAdminEmail(email) ? 'admin' : 'user';
    const res = this.db.run(
      `INSERT INTO users(email, password_hash, nickname, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      email,
      hashSync(password, 10),
      nickname || email.split('@')[0],
      role,
      now,
      now,
    );
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', Number(res.lastInsertRowid))!;
    this.db.run(
      `INSERT INTO profiles(user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO NOTHING`,
      user.id,
      JSON.stringify({}),
      now,
    );
    return { user_id: user.id, email: user.email, ...this.issue(user) };
  }

  login(email: unknown, password: unknown) {
    if (!isEmail(email) || typeof password !== 'string') {
      throw BizError.invalid('邮箱或密码格式不正确');
    }
    const user = this.db.get<UserRow>('SELECT * FROM users WHERE email = ?', email);
    if (!user || !compareSync(password, user.password_hash)) {
      throw BizError.unauthenticated('邮箱或密码错误');
    }
    return { user_id: user.id, email: user.email, ...this.issue(user) };
  }

  refresh(refreshToken: unknown) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw BizError.invalid('缺少 refresh_token');
    }
    const row = this.db.get<{ user_id: number; expires_at: string; revoked: number }>(
      'SELECT user_id, expires_at, revoked FROM refresh_tokens WHERE token = ?',
      refreshToken,
    );
    if (!row || row.revoked) throw BizError.unauthenticated('refresh_token 无效');
    if (Date.parse(row.expires_at) < Date.now()) throw BizError.unauthenticated('refresh_token 已过期');

    const user = this.db.get<UserRow>('SELECT * FROM users WHERE id = ?', row.user_id);
    if (!user) throw BizError.unauthenticated('用户不存在');

    this.db.run('UPDATE refresh_tokens SET revoked = 1 WHERE token = ?', refreshToken);
    return { user_id: user.id, email: user.email, ...this.issue(user) };
  }

  logout(refreshToken: unknown) {
    if (typeof refreshToken === 'string' && refreshToken) {
      this.db.run('UPDATE refresh_tokens SET revoked = 1 WHERE token = ?', refreshToken);
    }
    return { ok: true };
  }
}
