import { Module } from '@nestjs/common';
import { PlatformController, SubscriptionsController } from './platform.controller';
import { PlatformService } from './platform.service';
import { PlatformAdminGuard, SolutionGuard } from './platform.guards';

/** Платформа: администратор платформы, подписки организаций на решения («Учётная система», «Бухгалтерия», «Супервайзер»). */
@Module({
  controllers: [PlatformController, SubscriptionsController],
  providers: [PlatformService, PlatformAdminGuard, SolutionGuard],
  exports: [PlatformService, SolutionGuard],
})
export class PlatformModule {}
