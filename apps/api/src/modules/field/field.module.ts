import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { FieldAgentController, FieldController } from './field.controller';
import { FieldService } from './field.service';
import { FieldReportsService } from './field-reports.service';
import { FieldAgentService, FieldDeviceGuard } from './field-agent.service';
import { FieldPhotoStore } from './field-photos';

/** Решение «Супервайзер»: торговые представители, точки, маршруты, задания, посещения с фото. */
@Module({
  imports: [PlatformModule],
  controllers: [FieldController, FieldAgentController],
  providers: [FieldService, FieldReportsService, FieldAgentService, FieldDeviceGuard, FieldPhotoStore],
})
export class FieldModule {}
