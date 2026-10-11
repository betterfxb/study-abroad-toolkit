/**
 * 用户资料模块（契约 §2）。
 *
 * GET   /api/v1/profile   获取结构化资料
 * PUT   /api/v1/profile   全量替换
 * PATCH /api/v1/profile   局部更新（JSON Merge Patch，RFC 7396）
 */

import { Injectable } from '@nestjs/common';
import { BizError } from '../common/biz-error';
import { DatabaseService } from '../db/database.service';

/**
 * JSON Merge Patch（RFC 7396）：
 *   - 值为 null  → 删除该键
 *   - 值为对象  → 递归合并
 *   - 其他值    → 直接替换
 */
export function mergePatch(target: any, patch: any): any {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }
  const base = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      base[key] = mergePatch(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** 档案顶层允许的键（防止写入任意字段） */
const ALLOWED_TOP_KEYS = [
  'basic_info',
  'education',
  'tests',
  'experiences',
  'addresses',
  'documents',
  'preferences',
];

@Injectable()
export class ProfileService {
  constructor(private readonly db: DatabaseService) {}

  get(userId: number): Record<string, any> {
    const row = this.db.get<{ data: string }>('SELECT data FROM profiles WHERE user_id = ?', userId);
    if (!row) return {};
    try {
      return JSON.parse(row.data);
    } catch {
      return {};
    }
  }

  private save(userId: number, data: Record<string, any>) {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO profiles(user_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      userId,
      JSON.stringify(data),
      now,
    );
    return data;
  }

  private validateShape(data: any) {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw BizError.invalid('资料必须是 JSON 对象');
    }
    for (const key of Object.keys(data)) {
      if (!ALLOWED_TOP_KEYS.includes(key)) {
        throw BizError.invalid(`不支持的字段：${key}（可用：${ALLOWED_TOP_KEYS.join(', ')}）`);
      }
    }
  }

  /** 全量替换 */
  replace(userId: number, data: any) {
    this.validateShape(data);
    return this.save(userId, data);
  }

  /** 局部更新 */
  patch(userId: number, patch: any) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw BizError.invalid('patch 必须是 JSON 对象');
    }
    const merged = mergePatch(this.get(userId), patch);
    this.validateShape(merged);
    return this.save(userId, merged);
  }
}
