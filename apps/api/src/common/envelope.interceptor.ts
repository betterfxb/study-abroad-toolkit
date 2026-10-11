/**
 * 统一响应封装拦截器。
 *
 * 契约「通用响应」：`{ code, message, data, trace_id }`
 * 所有成功响应经此包装；错误响应由 AllExceptionsFilter 处理。
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface Envelope<T> {
  code: number;
  message: string;
  data: T;
  trace_id: string;
}

/** 允许处理器直接返回「已封装」结果（跳过二次包装） */
export function envelope<T>(data: T, traceId = '', message = 'ok', code = 0) {
  return { code, message, data, trace_id: traceId } as Envelope<T>;
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const traceId = req.traceId || '';
    return next.handle().pipe(
      map((data) => {
        // 已封装（含 code 字段）则原样透传
        if (data && typeof data === 'object' && typeof data.code === 'number' && 'trace_id' in data) {
          return data;
        }
        return envelope(data ?? null, traceId);
      }),
    );
  }
}
