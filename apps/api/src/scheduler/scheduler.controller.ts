/**
 * 调度器运维接口（契约 §6.2 定时执行）。
 *
 *   GET  /api/v1/scheduler/status   调度器状态（需管理员）
 *   POST /api/v1/scheduler/tick     立即执行一轮扫描（需管理员）
 *
 * 之所以限管理员：这两个接口影响**全部用户**的订阅推送，不属于单用户资源。
 * 用户侧不需要它们——每条订阅的下次执行时间随订阅对象一起返回（`next_run_at`）。
 */

import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { BizError } from '../common/biz-error';
import { SchedulerService } from './scheduler.service';

@Controller('api/v1/scheduler')
@UseGuards(JwtAuthGuard)
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get('status')
  status(@CurrentUser() user: AuthUser) {
    if (user.role !== 'admin') throw BizError.forbidden('需要管理员权限');
    return this.scheduler.status();
  }

  @Post('tick')
  tick(@CurrentUser() user: AuthUser) {
    if (user.role !== 'admin') throw BizError.forbidden('需要管理员权限');
    return this.scheduler.tick();
  }
}
