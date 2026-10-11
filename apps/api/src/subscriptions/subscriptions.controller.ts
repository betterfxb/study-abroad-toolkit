import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { SubscriptionsService } from './subscriptions.service';

@Controller('api/v1/subscriptions')
@UseGuards(JwtAuthGuard)
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.subs.list(user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.subs.create(user.userId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.subs.update(user.userId, id, body);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.subs.remove(user.userId, id);
  }
}
