import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { DbContextMiddleware } from './common/db-context.middleware';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { OutboxModule } from './common/outbox/outbox.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { RolesModule } from './modules/roles/roles.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { TradeModule } from './modules/trade/trade.module';
import { PosModule } from './modules/pos/pos.module';
import { SyncModule } from './modules/sync/sync.module';
import { HrModule } from './modules/hr/hr.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AccountingModule } from './modules/accounting/accounting.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 300 }]),
    BullModule.forRoot({
      redis: process.env.REDIS_URL || 'redis://localhost:6379',
    }),
    PrismaModule,
    OutboxModule,
    AuthModule,
    UsersModule,
    RolesModule,
    CatalogModule,
    TradeModule,
    PosModule,
    SyncModule,
    HrModule,
    AnalyticsModule,
    AccountingModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(DbContextMiddleware).forRoutes('*');
  }
}
