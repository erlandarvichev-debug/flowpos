import { Controller, Get, Post, UseGuards, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { RolesService } from './roles.service';

@ApiTags('roles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('roles')
export class RolesController {
  constructor(private roles: RolesService) {}

  @Get()
  @RequirePermission('org.members.manage')
  findAll() {
    return this.roles.findAll();
  }

  /**
   * Глобальные роли старого модуля общие для всех клиентов: создание роли одним клиентом меняло бы список у всех.
   * Права даёт только роль в организации (FP-008), поэтому новые глобальные роли не создаются.
   */
  @Post()
  create() {
    throw new ForbiddenException('Роли задаются в организации (Настройки → Участники); новые глобальные роли не создаются');
  }

  @Get('permissions')
  @RequirePermission('org.members.manage')
  findPermissions() {
    return this.roles.findPermissions();
  }
}
