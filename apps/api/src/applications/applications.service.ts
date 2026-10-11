/**
 * 申请管理模块（契约 §5）。
 *
 * GET   /api/v1/institutions                              院校项目列表
 * POST  /api/v1/applications                              新建申请
 * GET   /api/v1/applications                              申请列表（按状态筛选）
 * PATCH /api/v1/applications/{id}                         更新进度
 * GET   /api/v1/applications/{id}/recommenders            推荐人列表
 * POST  /api/v1/applications/{id}/recommenders            添加推荐人
 * POST  /api/v1/applications/{id}/recommenders/{rid}/invite  记录「已邀请」
 *
 * 合规：推荐人邀请由用户在院校系统内自行完成，本服务只做**登记与状态跟踪**，不代发邀请邮件。
 */

import { Injectable } from '@nestjs/common';
import { BizError } from '../common/biz-error';
import { Pagination, parsePagination, pageResult } from '../common/pagination';
import { DatabaseService } from '../db/database.service';

const APPLICATION_STATUS = ['draft', 'in_progress', 'submitted', 'interview', 'offer', 'rejected'];
const RECOMMENDER_STATUS = ['pending', 'invited', 'submitted'];

export interface InstitutionRow {
  id: number;
  name: string;
  country: string;
  program: string;
  platform: string;
  deadline: string;
}

@Injectable()
export class ApplicationsService {
  constructor(private readonly db: DatabaseService) {}

  // ------------------------------------------------------------ 院校
  listInstitutions(query: Record<string, any>) {
    const p = parsePagination(query);
    const where: string[] = [];
    const params: any[] = [];
    if (query.country) {
      where.push('country = ?');
      params.push(String(query.country));
    }
    if (query.platform) {
      where.push('platform = ?');
      params.push(String(query.platform));
    }
    if (query.keyword) {
      where.push('(name LIKE ? OR program LIKE ?)');
      const kw = `%${query.keyword}%`;
      params.push(kw, kw);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM institutions ${clause}`, ...params)!.c;
    const items = this.db.all<InstitutionRow>(
      `SELECT * FROM institutions ${clause} ORDER BY id ASC LIMIT ? OFFSET ?`,
      ...params, p.size, p.offset,
    );
    return pageResult(items, total, p);
  }

  // ------------------------------------------------------------ 申请
  createApplication(userId: number, body: any) {
    const now = new Date().toISOString();
    let institutionName = String(body?.institution_name || '');
    let program = String(body?.program || '');
    let platform = String(body?.platform || '');
    let deadline = String(body?.deadline || '');

    // 支持按 institution_id 自动带出信息
    if (body?.institution_id) {
      const inst = this.db.get<InstitutionRow>(
        'SELECT * FROM institutions WHERE id = ?',
        Number(body.institution_id),
      );
      if (!inst) throw BizError.notFound('院校项目不存在');
      institutionName = institutionName || inst.name;
      program = program || inst.program;
      platform = platform || inst.platform;
      deadline = deadline || inst.deadline;
    }
    if (!institutionName) throw BizError.invalid('缺少 institution_name 或 institution_id');

    const res = this.db.run(
      `INSERT INTO applications(user_id, institution_id, institution_name, program, platform,
        status, progress, deadline, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?)`,
      userId,
      body?.institution_id ? Number(body.institution_id) : null,
      institutionName,
      program,
      platform,
      deadline,
      String(body?.notes || ''),
      now,
      now,
    );
    return this.getApplication(userId, Number(res.lastInsertRowid));
  }

  listApplications(userId: number, query: Record<string, any>) {
    const p = parsePagination(query);
    const where = ['user_id = ?'];
    const params: any[] = [userId];
    if (query.status && query.status !== 'all') {
      where.push('status = ?');
      params.push(String(query.status));
    }
    if (query.keyword) {
      where.push('(institution_name LIKE ? OR program LIKE ?)');
      const kw = `%${query.keyword}%`;
      params.push(kw, kw);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM applications ${clause}`, ...params)!.c;
    const items = this.db.all(
      `SELECT * FROM applications ${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      ...params, p.size, p.offset,
    );
    return pageResult(items, total, p);
  }

  getApplication(userId: number, id: number) {
    const row = this.db.get(
      'SELECT * FROM applications WHERE id = ? AND user_id = ?',
      id, userId,
    );
    if (!row) throw BizError.notFound('申请记录不存在');
    return row;
  }

  updateApplication(userId: number, id: number, body: any) {
    this.getApplication(userId, id); // 存在性与归属校验
    const sets: string[] = [];
    const params: any[] = [];

    if (body?.status !== undefined) {
      if (!APPLICATION_STATUS.includes(body.status)) {
        throw BizError.invalid(`status 非法（可用：${APPLICATION_STATUS.join(', ')}）`);
      }
      sets.push('status = ?');
      params.push(String(body.status));
    }
    if (body?.progress !== undefined) {
      const n = Number(body.progress);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw BizError.invalid('progress 需为 0~100');
      sets.push('progress = ?');
      params.push(Math.round(n));
    }
    for (const field of ['institution_name', 'program', 'platform', 'deadline', 'notes']) {
      if (body?.[field] !== undefined) {
        sets.push(`${field} = ?`);
        params.push(String(body[field]));
      }
    }
    if (!sets.length) throw BizError.invalid('没有可更新的字段');

    sets.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id, userId);
    this.db.run(`UPDATE applications SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`, ...params);
    return this.getApplication(userId, id);
  }

  // ------------------------------------------------------------ 推荐人
  listRecommenders(userId: number, applicationId: number) {
    this.getApplication(userId, applicationId);
    return this.db.all(
      'SELECT * FROM recommenders WHERE application_id = ? ORDER BY id ASC',
      applicationId,
    );
  }

  addRecommender(userId: number, applicationId: number, body: any) {
    this.getApplication(userId, applicationId);
    const name = String(body?.name || '').trim();
    if (!name) throw BizError.invalid('缺少推荐人姓名');
    const res = this.db.run(
      `INSERT INTO recommenders(application_id, name, email, title, org, status, invited_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', '', ?)`,
      applicationId,
      name,
      String(body?.email || ''),
      String(body?.title || ''),
      String(body?.org || ''),
      new Date().toISOString(),
    );
    return this.db.get('SELECT * FROM recommenders WHERE id = ?', Number(res.lastInsertRowid));
  }

  markInvited(userId: number, applicationId: number, recommenderId: number) {
    this.getApplication(userId, applicationId);
    const rec = this.db.get<{ id: number }>(
      'SELECT id FROM recommenders WHERE id = ? AND application_id = ?',
      recommenderId, applicationId,
    );
    if (!rec) throw BizError.notFound('推荐人不存在');
    this.db.run(
      `UPDATE recommenders SET status = 'invited', invited_at = ? WHERE id = ?`,
      new Date().toISOString(), recommenderId,
    );
    return this.db.get('SELECT * FROM recommenders WHERE id = ?', recommenderId);
  }
}

export { APPLICATION_STATUS, RECOMMENDER_STATUS };
