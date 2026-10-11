import { Module } from '@nestjs/common';
import { ProxyModule } from '../proxy/proxy.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/** 订阅匹配与推送模块（契约 §6.2） */
@Module({
  imports: [SubscriptionsModule, ProxyModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
