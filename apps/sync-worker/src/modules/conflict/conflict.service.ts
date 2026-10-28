import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

/**
 * Конфигурация политики конфликтов по типу сущности.
 * Owner: platform — платформа главнее (push наших данных).
 * Owner: c1 — 1С главнее (затираем локальные изменения).
 * Owner: manual — пользователь решает вручную.
 */
const CONFLICT_POLICY: Record<string, 'PLATFORM' | 'C1' | 'MANUAL'> = {
  // Документы — хозяин платформа
  DEMAND: 'PLATFORM',
  RETAIL_DEMAND: 'PLATFORM',
  RETAIL_RETURN: 'PLATFORM',
  MOVE: 'PLATFORM',
  INVENTORY: 'PLATFORM',
  ENTER: 'PLATFORM',
  LOSS: 'PLATFORM',
  // Справочники — хозяин 1С
  product: 'C1',
  product_group: 'C1',
  uom: 'C1',
  price_type: 'C1',
  price: 'C1',
  store: 'C1',
  counterparty: 'C1',
  // Закупки/продажи — ручное разрешение
  PURCHASE_ORDER: 'MANUAL',
  CUSTOMER_ORDER: 'MANUAL',
};

@Injectable()
export class ConflictService {
  private readonly logger = new Logger(ConflictService.name);

  constructor(private prisma: PrismaService) {}

  getPolicy(entity: string): 'PLATFORM' | 'C1' | 'MANUAL' {
    return CONFLICT_POLICY[entity] ?? 'MANUAL';
  }

  async resolveConflict(entity: string, localId: string, resolution: 'keep_local' | 'take_1c') {
    const policy = this.getPolicy(entity);

    if (resolution === 'keep_local' || policy === 'PLATFORM') {
      await this.keepLocal(entity, localId);
    } else {
      await this.take1c(entity, localId);
    }
  }

  private async keepLocal(entity: string, localId: string) {
    if (entity === 'document' || entity in ['DEMAND', 'RETAIL_DEMAND']) {
      await this.prisma.document.update({
        where: { id: localId },
        data: { syncStatus: 'DIRTY', owner: 'PLATFORM' },
      });
    }
    this.logger.log(`Conflict resolved: keep local for ${entity}/${localId}`);
  }

  private async take1c(entity: string, localId: string) {
    if (entity === 'product') {
      await this.prisma.product.update({
        where: { id: localId },
        data: { syncStatus: 'SYNCED', owner: 'C1' },
      });
    } else if (entity === 'counterparty') {
      await this.prisma.counterparty.update({
        where: { id: localId },
        data: { syncStatus: 'SYNCED', owner: 'C1' },
      });
    }
    this.logger.log(`Conflict resolved: take from 1C for ${entity}/${localId}`);
  }
}
