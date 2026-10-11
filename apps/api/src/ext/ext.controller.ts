/**
 * 插件填写会话与日志接口（契约 §4.2 / §4.3）。
 *
 * 凭证支持控制台 Bearer 与插件 X-Ext-Token（守卫统一处理）。
 * 所有会话按 user_id 隔离，越权访问一律 2001。
 */

import {
  Body, Controller, Get, Param, Patch, Post, Req, UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { ExtService, sessionView } from './ext.service';

type Traced = Request & { traceId?: string };

@Controller('ext/v1')
@UseGuards(JwtAuthGuard)
export class ExtController {
  constructor(private readonly ext: ExtService) {}

  @Post('fill-logs')
  fillLogs(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.ext.reportLogs(user.userId, body);
  }

  @Post('sessions')
  createSession(@CurrentUser() user: AuthUser, @Body() body: any) {
    return sessionView(this.ext.createSession(user.userId, body || {}));
  }

  @Patch('sessions/:id')
  patchSession(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return sessionView(this.ext.patchSession(user.userId, Number(id), body || {}));
  }

  @Get('sessions/:id')
  getSession(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ext.sessionDetail(user.userId, Number(id));
  }

  @Post('sessions/:id/block')
  blockSession(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return sessionView(this.ext.blockSession(user.userId, Number(id), body || {}));
  }
}
