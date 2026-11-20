import {
  Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, Res, StreamableFile, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentScope, Scope } from '../../common/scope';
import { OrgGuard, RequirePermission } from '../accounting/access/org-context';
import { RequireSolution, SolutionGuard } from '../platform/platform.guards';
import { PrismaService } from '../../prisma/prisma.service';
import { FieldService } from './field.service';
import { DEVICE_HEADER, FieldAgentService, FieldDevice, FieldDeviceCtx, FieldDeviceGuard, UploadedPhoto } from './field-agent.service';
import { FieldPhotoStore } from './field-photos';
import { PHOTO_MAX_BYTES } from './field-logic';

/** Рабочее место супервайзера на сайте. Только при подключённом решении «Супервайзер». */
@ApiTags('field')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, SolutionGuard)
@RequireSolution('supervisor')
@Controller('field')
export class FieldController {
  constructor(private field: FieldService, private prisma: PrismaService, private photos: FieldPhotoStore) {}

  @Get('defaults') @RequirePermission('field.read')
  defaults() { return this.field.defaults(); }

  @Get('reps') @RequirePermission('field.read')
  reps(@CurrentScope() s: Scope) { return this.field.reps(s); }

  @Post('reps') @RequirePermission('field.manage')
  createRep(@CurrentScope() s: Scope, @Body() b: any) { return this.field.createRep(s, b); }

  @Put('reps/:id') @RequirePermission('field.manage')
  updateRep(@CurrentScope() s: Scope, @Param('id') id: string, @Body() b: any) { return this.field.updateRep(s, id, b); }

  @Post('reps/:id/bind-code') @RequirePermission('field.manage')
  bindCode(@CurrentScope() s: Scope, @Param('id') id: string) { return this.field.bindCode(s, id); }

  @Delete('devices/:id') @RequirePermission('field.manage')
  revokeDevice(@CurrentScope() s: Scope, @Param('id') id: string) { return this.field.revokeDevice(s, id); }

  @Get('points') @RequirePermission('field.read')
  points(@CurrentScope() s: Scope, @Query() q: any) { return this.field.points(s, q); }

  @Post('points') @RequirePermission('field.manage')
  createPoint(@CurrentScope() s: Scope, @Body() b: any) { return this.field.createPoint(s, b); }

  @Put('points/:id') @RequirePermission('field.manage')
  updatePoint(@CurrentScope() s: Scope, @Param('id') id: string, @Body() b: any) { return this.field.updatePoint(s, id, b); }

  @Get('routes') @RequirePermission('field.read')
  route(@CurrentScope() s: Scope, @Query('repId') repId: string, @Query('date') date: string) { return this.field.route(s, repId, date); }

  @Put('routes') @RequirePermission('field.manage')
  saveRoute(@CurrentScope() s: Scope, @Body() b: any) { return this.field.saveRoute(s, b); }

  @Post('routes/copy') @RequirePermission('field.manage')
  copyRoute(@CurrentScope() s: Scope, @Body() b: any) { return this.field.copyRoute(s, b); }

  @Get('tasks') @RequirePermission('field.read')
  tasks(@CurrentScope() s: Scope, @Query() q: any) { return this.field.tasks(s, q); }

  @Post('tasks') @RequirePermission('field.manage')
  createTask(@CurrentScope() s: Scope, @Body() b: any) { return this.field.createTask(s, b); }

  @Put('tasks/:id') @RequirePermission('field.manage')
  updateTask(@CurrentScope() s: Scope, @Param('id') id: string, @Body() b: any) { return this.field.updateTask(s, id, b); }

  @Get('visits') @RequirePermission('field.read')
  visits(@CurrentScope() s: Scope, @Query() q: any) { return this.field.visits(s, q); }

  @Get('day') @RequirePermission('field.read')
  day(@CurrentScope() s: Scope, @Query() q: any) { return this.field.day(s, q); }

  @Get('plan-fact') @RequirePermission('field.read')
  planFact(@CurrentScope() s: Scope, @Query() q: any) { return this.field.planFact(s, q); }

  /** Файл фото посещения (только своей организации). */
  @Get('photos/:id') @RequirePermission('field.read')
  async photo(@CurrentScope() s: Scope, @Param('id') id: string, @Res({ passthrough: true }) res: any) {
    const row = await this.prisma.fieldPhoto.findFirst({ where: { id, organizationId: s.organizationId } });
    if (!row) throw new NotFoundException('Фото не найдено');
    const buf = await this.photos.read(row.path).catch(() => { throw new NotFoundException('Файл фото удалён'); });
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=86400' });
    return new StreamableFile(buf);
  }
}

/** API агента на телефоне представителя. Вход — токен телефона (X-Device-Token), выданный при привязке кодом. */
@ApiTags('field-agent')
@Controller('field/agent')
export class FieldAgentController {
  constructor(private agent: FieldAgentService) {}

  /** Привязка кодом из 6 цифр. Не чаще 10 попыток в минуту — перебор кода бесполезен. */
  @Post('bind')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  bind(@Body() b: any) { return this.agent.bind(b); }

  @Get('me') @UseGuards(FieldDeviceGuard) @ApiHeader({ name: DEVICE_HEADER })
  me(@FieldDevice() d: FieldDeviceCtx) { return this.agent.me(d); }

  @Post('unbind') @UseGuards(FieldDeviceGuard)
  unbind(@FieldDevice() d: FieldDeviceCtx) { return this.agent.unbind(d); }

  @Get('today') @UseGuards(FieldDeviceGuard)
  today(@FieldDevice() d: FieldDeviceCtx, @Query('date') date?: string) { return this.agent.today(d, date); }

  @Post('points/sync') @UseGuards(FieldDeviceGuard)
  syncPoints(@FieldDevice() d: FieldDeviceCtx, @Body() b: any) { return this.agent.syncPoints(d, b); }

  @Post('points/:id/location') @UseGuards(FieldDeviceGuard)
  rememberLocation(@FieldDevice() d: FieldDeviceCtx, @Param('id') id: string, @Body() b: any) { return this.agent.rememberLocation(d, id, b); }

  @Post('visits') @UseGuards(FieldDeviceGuard)
  visit(@FieldDevice() d: FieldDeviceCtx, @Body() b: any) { return this.agent.visit(d, b); }

  @Post('visits/:clientUuid/photos') @UseGuards(FieldDeviceGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: PHOTO_MAX_BYTES, files: 1 } }))
  photo(@FieldDevice() d: FieldDeviceCtx, @Param('clientUuid') visitClientUuid: string, @UploadedFile() file: UploadedPhoto | undefined, @Body() b: any) {
    return this.agent.photo(d, visitClientUuid, file, b);
  }

  @Post('orders') @UseGuards(FieldDeviceGuard)
  order(@FieldDevice() d: FieldDeviceCtx, @Body() b: any) { return this.agent.order(d, b); }

  @Post('track') @UseGuards(FieldDeviceGuard)
  track(@FieldDevice() d: FieldDeviceCtx, @Body() b: any) { return this.agent.track(d, b); }
}
