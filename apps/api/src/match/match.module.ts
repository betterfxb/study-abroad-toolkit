import { Module } from '@nestjs/common';
import { ProfileModule } from '../profile/profile.module';
import { MatchController } from './match.controller';

/** 岗位匹配度评分模块（DatabaseService 为 @Global，无需显式导入） */
@Module({
  imports: [ProfileModule],
  controllers: [MatchController],
})
export class MatchModule {}
