import { Body, Controller, Get, Patch, Put, UseGuards } from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { ProfileService } from './profile.service';

@Controller('api/v1/profile')
@UseGuards(JwtAuthGuard)
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.profile.get(user.userId);
  }

  @Put()
  replace(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.replace(user.userId, body);
  }

  @Patch()
  patch(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.profile.patch(user.userId, body);
  }
}
