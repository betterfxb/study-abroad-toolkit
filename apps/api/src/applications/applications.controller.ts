import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser, JwtAuthGuard } from '../auth/jwt.guard';
import { ApplicationsService } from './applications.service';

@Controller('api/v1')
@UseGuards(JwtAuthGuard)
export class ApplicationsController {
  constructor(private readonly apps: ApplicationsService) {}

  @Get('institutions')
  listInstitutions(@Query() query: Record<string, any>) {
    return this.apps.listInstitutions(query);
  }

  @Post('applications')
  create(@CurrentUser() user: AuthUser, @Body() body: any) {
    return this.apps.createApplication(user.userId, body);
  }

  @Get('applications')
  list(@CurrentUser() user: AuthUser, @Query() query: Record<string, any>) {
    return this.apps.listApplications(user.userId, query);
  }

  @Patch('applications/:id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.apps.updateApplication(user.userId, id, body);
  }

  @Get('applications/:id/recommenders')
  listRecommenders(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number) {
    return this.apps.listRecommenders(user.userId, id);
  }

  @Post('applications/:id/recommenders')
  addRecommender(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: any,
  ) {
    return this.apps.addRecommender(user.userId, id, body);
  }

  @Post('applications/:id/recommenders/:rid/invite')
  invite(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Param('rid', ParseIntPipe) rid: number,
  ) {
    return this.apps.markInvited(user.userId, id, rid);
  }
}
