import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { PullService } from './modules/pull/pull.service';
import { ConflictService } from './modules/conflict/conflict.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
  ],
  providers: [PrismaService, PullService, ConflictService],
})
export class SyncWorkerModule {}
