import { Controller, Get, Headers, NotFoundException, Res, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { EsfMonitorService } from './esf-monitor.service';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * FP-022: метрики для Prometheus. Только по токену OPS_METRICS_TOKEN (Authorization: Bearer …, ≥ 32 символов); токен
 * не задан — эндпоинта нет (404). Метки — идентификаторы организаций, без имён, БИН и персональных данных.
 */
@ApiExcludeController()
@Controller('ops')
export class OpsMetricsController {
  constructor(private monitor: EsfMonitorService) {}

  @Get('metrics')
  async metrics(@Headers('authorization') auth: string | undefined, @Res() res: Response) {
    const token = process.env.OPS_METRICS_TOKEN ?? '';
    // Не задан, короткий или не заменённая заглушка из примера настроек — эндпоинта нет.
    if (token.length < 32 || token.includes('<')) throw new NotFoundException();
    const given = /^Bearer\s+(.+)$/i.exec(auth ?? '')?.[1] ?? '';
    if (!timingSafeEqual(digest(given), digest(token))) throw new UnauthorizedException();
    res.type('text/plain; version=0.0.4').send(await this.monitor.prometheus());
  }
}
