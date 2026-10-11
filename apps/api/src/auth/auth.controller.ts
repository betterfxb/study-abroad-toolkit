/** 鉴权控制器（契约 §1） */

import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt.guard';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  register(@Body() body: any) {
    return this.auth.register(body?.email, body?.password, body?.nickname);
  }

  @Post('login')
  login(@Body() body: any) {
    return this.auth.login(body?.email, body?.password);
  }

  @Post('refresh')
  refresh(@Body() body: any) {
    return this.auth.refresh(body?.refresh_token);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  logout(@Body() body: any) {
    return this.auth.logout(body?.refresh_token);
  }
}
