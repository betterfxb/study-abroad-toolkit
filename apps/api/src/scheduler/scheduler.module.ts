import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { SchedulerController } from './scheduler.controller';
import { SchedulerService } from './scheduler.service';

/** 订阅定时调度（契约 §6.2） */
@Module({
  imports: [SubscriptionsModule, NotificationsModule],
  controllers: [SchedulerController],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
