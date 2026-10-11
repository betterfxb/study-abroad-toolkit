/**
 * 全局异常过滤器：把任何异常转成契约「通用响应」。
 * 保证前端只需处理一种响应结构。
 */

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { BizError, ErrorCode, httpStatusToCode } from './biz-error';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<any>();
    const traceId = req?.traceId || '';

    let httpStatus = 500;
    let code: number = ErrorCode.INTERNAL;
    let message = '服务器内部错误';

    if (exception instanceof BizError) {
      httpStatus = exception.httpStatus;
      code = exception.code;
      message = exception.message;
    } else if (exception instanceof HttpException) {
      httpStatus = exception.getStatus();
      code = httpStatusToCode(httpStatus);
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const m = (body as any).message;
        message = Array.isArray(m) ? m.join('; ') : m || exception.message;
      }
      // 契约未定义的状态码归入内部错误，但保留原始 HTTP 语义
      if (code === ErrorCode.INTERNAL && httpStatus < 500) {
        code = ErrorCode.INVALID_PARAM;
      }
    } else {
      const err = exception as Error;
      this.logger.error(`未捕获异常: ${err?.message}`, err?.stack);
      message = '服务器内部错误';
    }

    res.status(httpStatus).json({
      code,
      message,
      data: null,
      trace_id: traceId,
    });
  }
}
