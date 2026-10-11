import { Module } from '@nestjs/common';
import { ProxyModule } from '../proxy/proxy.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [ProxyModule],
  controllers: [AdminController],
})
export class AdminModule {}
