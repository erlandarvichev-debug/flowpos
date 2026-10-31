import { Module } from '@nestjs/common';
import { ItemsController } from './items.controller';
import { ItemsService } from './items.service';
import { BarcodesService } from './barcodes.service';
import { WarehousesController } from './warehouses.controller';
import { WarehousesService } from './warehouses.service';
import { CounterpartiesController } from './counterparties.controller';
import { CounterpartiesService } from './counterparties.service';

@Module({
  controllers: [ItemsController, WarehousesController, CounterpartiesController],
  providers: [ItemsService, BarcodesService, WarehousesService, CounterpartiesService],
  exports: [ItemsService, BarcodesService, WarehousesService, CounterpartiesService],
})
export class CatalogModule {}
