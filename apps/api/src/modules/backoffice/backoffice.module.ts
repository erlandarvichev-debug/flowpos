/**
 * FP-004: Backoffice Module
 * Centralized provider management and integration
 */

import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BackofficeProviderRegistryImpl } from './backoffice.registry';
import { OnecBackofficeProvider } from './onec.backoffice.provider';
import { MoyskladBackofficeProvider } from './moysklad.backoffice.provider';
import { InternalBackofficeProvider } from './internal.backoffice.provider';

@Module({
  imports: [PrismaModule],
  providers: [
    OnecBackofficeProvider,
    MoyskladBackofficeProvider,
    InternalBackofficeProvider,
    {
      provide: 'BACKOFFICE_REGISTRY',
      useClass: BackofficeProviderRegistryImpl,
    },
  ],
  exports: [
    'BACKOFFICE_REGISTRY',
    OnecBackofficeProvider,
    MoyskladBackofficeProvider,
    InternalBackofficeProvider,
  ],
})
export class BackofficeModule {}
