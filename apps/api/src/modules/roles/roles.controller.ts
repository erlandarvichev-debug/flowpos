import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('roles')
export class RolesController {
  constructor(private roles: RolesService) {}

  @Get()
  findAll() {
    return this.roles.findAll();
  }

  @Post()
  create(@Body() body: any) {
    return this.roles.create(body);
  }

  @Get('permissions')
  findPermissions() {
    return this.roles.findPermissions();
  }
}
