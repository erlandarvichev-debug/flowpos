import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequireMfa, RequirePermission } from '../accounting/access/org-context';
import { CurrentScope, Scope } from '../../common/scope';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  @RequirePermission('org.members.manage')
  findAll(@CurrentScope() s: Scope) {
    return this.users.findAll(s);
  }

  @Get(':id')
  @RequirePermission('org.members.manage')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.users.findOne(s, id);
  }

  @Post()
  @RequirePermission('org.members.manage')
  @RequireMfa()
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.users.create(s, body);
  }

  @Put(':id')
  @RequirePermission('org.members.manage')
  @RequireMfa()
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.users.update(s, id, body);
  }

  @Post(':id/revoke-sessions')
  @RequirePermission('org.members.manage')
  @RequireMfa()
  revokeSessions(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.users.revokeSessions(s, id);
  }

  @Delete(':id')
  @RequirePermission('org.members.manage')
  @RequireMfa()
  deactivate(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.users.deactivate(s, id);
  }
}
