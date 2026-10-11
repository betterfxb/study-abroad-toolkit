import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

/** 全局数据库模块：任何模块都可注入 DatabaseService */
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
