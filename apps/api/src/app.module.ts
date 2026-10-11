import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from './admin/admin.module';
import { ApplicationsModule } from './applications/applications.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { EnvelopeInterceptor } from './common/envelope.interceptor';
import { IdempotencyInterceptor, IdempotencyService } from './common/idempotency';
import { RateLimitInterceptor, RateLimitService } from './common/rate-limit';
import { TraceMiddleware } from './common/trace.middleware';
import { DatabaseModule } from './db/database.module';
import { DocumentsModule } from './documents/documents.module';
import { ExtModule } from './ext/ext.module';
import { HealthController } from './health.controller';
import { NotificationsModule } from './notifications/notifications.module';
import { ProfileModule } from './profile/profile.module';
import { ProxyModule } from './proxy/proxy.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    AdminModule,
    ProfileModule,
    DocumentsModule,
    ApplicationsModule,
    SubscriptionsModule,
    NotificationsModule,
    SchedulerModule,
    ExtModule,
    ProxyModule,
  ],
  controllers: [HealthController],
  providers: [
    IdempotencyService,
    RateLimitService,
    // 限流**放在最前**：被限流的请求不应再消耗幂等记录或执行业务逻辑
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    // 响应统一封装
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    // 幂等（仅对带 Idempotency-Key 的 POST 生效）
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    // 异常统一转换
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Express 5 使用命名通配符（'*' 已失效）
    consumer
      .apply(TraceMiddleware)
      .forRoutes({ path: '{*splat}', method: RequestMethod.ALL });
  }
}
