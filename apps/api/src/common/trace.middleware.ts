/**
 * trace_id 中间件：为每个请求分配链路 ID。
 * 优先复用上游传入的 X-Trace-Id，便于跨服务串联（网关 → intelligence → crawler）。
 */

import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request & { traceId?: string }, res: Response, next: NextFunction) {
    const incoming = req.header('x-trace-id');
    const traceId = incoming && incoming.length <= 64 ? incoming : randomBytes(8).toString('hex');
    req.traceId = traceId;
    res.setHeader('X-Trace-Id', traceId);
    next();
  }
}
