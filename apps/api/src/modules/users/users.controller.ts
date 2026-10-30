import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { UsersService } from './users.service';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  findAll(@CurrentScope() s: Scope) {
    return this.users.findAll(s);
  }

  @Get(':id')
  findOne(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.users.findOne(s, id);
  }

  @Post()
  create(@CurrentScope() s: Scope, @Body() body: any) {
    return this.users.create(s, body);
  }

  @Put(':id')
  update(@CurrentScope() s: Scope, @Param('id') id: string, @Body() body: any) {
    return this.users.update(s, id, body);
  }

  @Post(':id/revoke-sessions')
  revokeSessions(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.users.revokeSessions(s, id);
  }

  @Delete(':id')
  deactivate(@CurrentScope() s: Scope, @Param('id') id: string) {
    return this.users.deactivate(s, id);
  }
}
