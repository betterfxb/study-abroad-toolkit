/**
 * 岗位匹配度评分端点（契约 §6：POST /api/v1/match/jobs）。
 *
 * 客户端把**当前页岗位快照**传上来（jobs 读接口免鉴权、数据公开），
 * 服务端结合本人档案打分返回 —— 分数仅作展示参考，不构成任何安全边界。
 *
 * 城市偏好来源：preferences.preferred_cities ∪ 本人启用中的订阅 cities（兜底）。
 * 限流：common/rate-limit.ts 的 match 规则（60/min，按用户计数）。
 */

import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { BizError } from '../common/biz-error';
import { DatabaseService } from '../db/database.service';
import { ProfileService } from '../profile/profile.service';
import { scoreJobs } from './profile-match';

const MAX_JOBS = 100;

@Controller('api/v1/match')
@UseGuards(JwtAuthGuard)
export class MatchController {
  constructor(
    private readonly profile: ProfileService,
    private readonly db: DatabaseService,
  ) {}

  @Post('jobs')
  score(@CurrentUser() user: AuthUser, @Body() body: any) {
    const jobs = body?.jobs;
    if (!Array.isArray(jobs) || jobs.length === 0 || jobs.length > MAX_JOBS) {
      throw BizError.invalid(`jobs 须为 1~${MAX_JOBS} 条数组`);
    }
    for (const j of jobs) {
      if (!j || typeof j !== 'object' || typeof j.id !== 'number' || !Number.isFinite(j.id)) {
        throw BizError.invalid('每条 job 须含数值 id');
      }
    }
    const profile = this.profile.get(user.userId) || {};
    const cities = this.subscriptionCities(user.userId);
    return { scores: scoreJobs(profile, jobs, { cities }) };
  }

  /** 启用中订阅的城市（JSONB 文本解析；任何异常降级为空，不阻断评分） */
  private subscriptionCities(userId: number): string[] {
    try {
      const rows = this.db.all<{ cities: string }>(
        'SELECT cities FROM subscriptions WHERE user_id = ? AND enabled = 1',
        userId,
      );
      const out: string[] = [];
      for (const r of rows) {
        try {
          const arr = JSON.parse(String(r.cities || '[]'));
          if (Array.isArray(arr)) {
            for (const c of arr) {
              if (typeof c === 'string' && c.trim()) out.push(c.trim());
            }
          }
        } catch {
          // 单行脏数据跳过，不影响其余
        }
      }
      return Array.from(new Set(out));
    } catch {
      return [];
    }
  }
}
