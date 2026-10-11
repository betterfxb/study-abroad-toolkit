/**
 * 鉴权守卫与当前用户装饰器。
 *
 * 凭证来源（契约 §1 约定）：
 *   * 控制台：`Authorization: Bearer <JWT>`
 *   * 插件：  `X-Ext-Token: <JWT>`
 */

import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { BizError } from '../common/biz-error';

export interface AuthUser {
  userId: number;
  email: string;
  role: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const auth = req.header?.('authorization') || '';
    const ext = req.header?.('x-ext-token') || '';

    let token = '';
    if (auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim();
    else if (ext) token = ext.trim();

    if (!token) throw BizError.unauthenticated('缺少访问凭证');

    try {
      const payload = this.jwt.verify(token);
      req.user = {
        userId: payload.sub,
        email: payload.email,
        role: payload.role || 'user',
      } as AuthUser;
      return true;
    } catch {
      throw BizError.unauthenticated('凭证无效或已过期');
    }
  }
}

/** 取当前登录用户 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    return ctx.switchToHttp().getRequest().user;
  },
);
