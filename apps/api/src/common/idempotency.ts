/**
 * 幂等支持（契约 §9 约定 4）：
 *   POST 写接口需带 `Idempotency-Key`（UUID），24h 内同键返回首次结果。
 *
 * 实现：拦截器在请求进入业务前查缓存；业务成功后写入缓存。
 * 无 Key 时正常执行（不强制，避免破坏只读语义与测试便利）。
 */

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { DatabaseService } from '../db/database.service';

const TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyService {
  constructor(private readonly db: DatabaseService) {}

  get(key: string): any | null {
    const row = this.db.get<{ response: string; created_at: string }>(
      'SELECT response, created_at FROM idempotency WHERE key = ?',
      key,
    );
    if (!row) return null;
    if (Date.now() - Date.parse(row.created_at) > TTL_MS) {
      this.db.run('DELETE FROM idempotency WHERE key = ?', key);
      return null;
    }
    try {
      return JSON.parse(row.response);
    } catch {
      return null;
    }
  }

  save(key: string, payload: any) {
    this.db.run(
      `INSERT INTO idempotency(key, response, created_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET response = excluded.response, created_at = excluded.created_at`,
      key,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
  }
}

/** 仅对 POST 生效；带 Idempotency-Key 且命中缓存时直接返回首次结果 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly idem: IdempotencyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    if (req.method !== 'POST') return next.handle();

    const key = req.header?.('idempotency-key');
    if (!key) return next.handle();

    const cached = this.idem.get(key);
    if (cached) return of(cached);

    return next.handle().pipe(tap((data) => this.idem.save(key, data)));
  }
}
