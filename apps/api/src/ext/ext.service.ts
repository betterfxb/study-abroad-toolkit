/**
 * 插件填写会话与日志（契约 §4.2 / §4.3）。
 *
 *   POST   /ext/v1/fill-logs               批量上报字段级结果
 *   POST   /ext/v1/sessions                创建填写会话
 *   PATCH  /ext/v1/sessions/{id}           更新步骤与统计
 *   GET    /ext/v1/sessions/{id}           查询会话状态（断点续填）
 *   POST   /ext/v1/sessions/{id}/block     上报验证码/风控，标记 blocked
 *
 * 设计点：
 *   1. **网关本地实现，不经 intelligence 转发**：intelligence 是无状态匹配引擎，
 *      会话归属用户，必须落在网关（鉴权 + 用户隔离）。此前 proxy 的 fill-logs
 *      转发因上游无此路由而恒 404，现由本模块接管。
 *   2. **只存哈希不存原文**：logs 仅收 value_hash（插件本地计算或留空），
 *      字段原文永不落库。
 *   3. session_id 缺失时自动建会话（插件首版上报不带 id），避免孤儿日志；
 *      外键与 PG 0001 的 fill_sessions/fill_logs 同形，切库无需 DDL。
 */

import { Injectable } from '@nestjs/common';
import { BizError } from '../common/biz-error';
import { DatabaseService } from '../db/database.service';

/** 会话状态（与 0001 PG CHECK / 插件 STATE 对齐的子集） */
const SESSION_STATUS = ['running', 'paused', 'completed', 'failed', 'blocked'];

/** 合法转移：键为当前状态，值为允许的目标（含自身幂等） */
const SESSION_TRANSITIONS: Record<string, string[]> = {
  running: ['running', 'paused', 'completed', 'failed', 'blocked'],
  paused: ['paused', 'running'],
  blocked: ['blocked', 'running'],
  completed: ['completed'],
  failed: ['failed', 'running'],
};

/** 字段级结果（契约 §4.1 / 0001 CHECK） */
const LOG_RESULTS = ['filled', 'skipped', 'failed', 'low_confidence', 'manual'];

export interface FillSessionRow {
  id: number;
  user_id: number;
  application_id: number | null;
  system_code: string;
  step_index: number;
  status: string;
  stats: string;
  started_at: string;
  finished_at: string;
}

function parseStats(raw: string): any {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function sessionView(row: FillSessionRow, logs: any[] = []) {
  return {
    id: row.id,
    application_id: row.application_id,
    system_code: row.system_code,
    step_index: row.step_index,
    status: row.status,
    stats: parseStats(row.stats),
    started_at: row.started_at,
    finished_at: row.finished_at || '',
    logs,
  };
}

@Injectable()
export class ExtService {
  constructor(private readonly db: DatabaseService) {}

  /** 取归属当前用户的会话，越权/不存在一律 2001（不泄露他人会话存在性） */
  getOwned(userId: number, id: number): FillSessionRow {
    const row = this.db.get<FillSessionRow>(
      'SELECT * FROM fill_sessions WHERE id = ? AND user_id = ?',
      id, userId,
    );
    if (!row) throw BizError.notFound('填写会话不存在');
    return row;
  }

  createSession(userId: number, body: any): FillSessionRow {
    const now = new Date().toISOString();
    const applicationId = body?.application_id === undefined || body?.application_id === null
      ? null
      : Number(body.application_id);
    if (applicationId !== null && (!Number.isFinite(applicationId) || applicationId <= 0)) {
      throw BizError.invalid('application_id 非法');
    }
    const stepIndex = body?.step_index === undefined ? 0 : Number(body.step_index);
    if (!Number.isFinite(stepIndex) || stepIndex < 0) throw BizError.invalid('step_index 非法');
    const res = this.db.run(
      `INSERT INTO fill_sessions(user_id, application_id, system_code, step_index, status, stats, started_at, finished_at)
       VALUES (?, ?, ?, ?, 'running', '{}', ?, '')`,
      userId, applicationId, String(body?.system_code || ''), Math.floor(stepIndex), now,
    );
    return this.getOwned(userId, Number(res.lastInsertRowid));
  }

  patchSession(userId: number, id: number, body: any): FillSessionRow {
    const row = this.getOwned(userId, id);
    const sets: string[] = [];
    const params: any[] = [];

    if (body?.step_index !== undefined) {
      const n = Number(body.step_index);
      if (!Number.isFinite(n) || n < 0) throw BizError.invalid('step_index 非法');
      sets.push('step_index = ?');
      params.push(Math.floor(n));
    }
    if (body?.stats !== undefined) {
      if (!body.stats || typeof body.stats !== 'object' || Array.isArray(body.stats)) {
        throw BizError.invalid('stats 须为对象');
      }
      sets.push('stats = ?');
      params.push(JSON.stringify(body.stats));
    }
    if (body?.status !== undefined) {
      const next = String(body.status);
      if (!SESSION_STATUS.includes(next)) throw BizError.invalid(`status 非法（可用：${SESSION_STATUS.join(', ')}）`);
      const allowed = SESSION_TRANSITIONS[row.status] || [];
      if (!allowed.includes(next)) throw BizError.invalid(`状态转移非法：${row.status} → ${next}`);
      sets.push('status = ?');
      params.push(next);
      if ((next === 'completed' || next === 'failed') && !row.finished_at) {
        sets.push('finished_at = ?');
        params.push(new Date().toISOString());
      }
    }
    if (!sets.length) throw BizError.invalid('没有可更新的字段');
    this.db.run(`UPDATE fill_sessions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, ...params, id, userId);
    return this.getOwned(userId, id);
  }

  blockSession(userId: number, id: number, body: any): FillSessionRow {
    const row = this.getOwned(userId, id);
    const allowed = SESSION_TRANSITIONS[row.status] || [];
    if (!allowed.includes('blocked')) throw BizError.invalid(`状态转移非法：${row.status} → blocked`);
    const stats = parseStats(row.stats);
    if (body?.reason !== undefined) stats.block_reason = String(body.reason).slice(0, 500);
    stats.blocked_at = new Date().toISOString();
    this.db.run(
      'UPDATE fill_sessions SET status = ?, stats = ? WHERE id = ? AND user_id = ?',
      'blocked', JSON.stringify(stats), id, userId,
    );
    return this.getOwned(userId, id);
  }

  sessionDetail(userId: number, id: number) {
    const row = this.getOwned(userId, id);
    const logs = this.db.all(
      'SELECT id, field_key, selector, value_hash, confidence, result, message, created_at FROM fill_logs WHERE session_id = ? ORDER BY id ASC LIMIT 500',
      id,
    );
    return sessionView(row, logs);
  }

  reportLogs(userId: number, body: any) {
    const logs = body?.logs;
    if (!Array.isArray(logs) || logs.length === 0) throw BizError.invalid('logs 非空数组');
    if (logs.length > 500) throw BizError.invalid('单次上报最多 500 条');

    let sessionId = body?.session_id === undefined || body?.session_id === null
      ? null
      : Number(body.session_id);
    if (sessionId !== null && (!Number.isFinite(sessionId) || sessionId <= 0)) {
      throw BizError.invalid('session_id 非法');
    }
    // 首版插件上报不带会话：自动建一个归属调用者的 running 会话，避免孤儿日志
    if (sessionId === null) {
      sessionId = this.createSession(userId, {}).id;
    } else {
      this.getOwned(userId, sessionId);
    }

    const now = new Date().toISOString();
    let stored = 0;
    this.db.tx(() => {
      for (const item of logs) {
        const selector = String(item?.selector || '');
        if (!selector) throw BizError.invalid('log.selector 不能为空');
        const result = String(item?.result || 'skipped');
        if (!LOG_RESULTS.includes(result)) throw BizError.invalid(`log.result 非法（可用：${LOG_RESULTS.join(', ')}）`);
        let confidence: number | null = null;
        if (item?.confidence !== undefined && item?.confidence !== null) {
          confidence = Number(item.confidence);
          if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
            throw BizError.invalid('log.confidence 须为 0~1');
          }
        }
        this.db.run(
          `INSERT INTO fill_logs(session_id, field_key, selector, value_hash, confidence, result, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          sessionId,
          item?.field_key === undefined || item?.field_key === null ? null : String(item.field_key),
          selector,
          String(item?.value_hash || ''),
          confidence,
          result,
          String(item?.message || '').slice(0, 2000),
          now,
        );
        stored += 1;
      }
    });
    return { session_id: sessionId, received: logs.length, stored };
  }
}

export { LOG_RESULTS, SESSION_STATUS };
