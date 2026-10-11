import { Module } from '@nestjs/common';
import { ExtController } from './ext.controller';
import { ExtService } from './ext.service';

@Module({
  controllers: [ExtController],
  providers: [ExtService],
  exports: [ExtService],
})
export class ExtModule {}
