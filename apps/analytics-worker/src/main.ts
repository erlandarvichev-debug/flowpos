import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AnalyticsWorkerModule } from './analytics-worker.module';

async function bootstrap() {
  const app = await NestFactory.create(AnalyticsWorkerModule, { logger: ['log', 'warn', 'error'] });
  await app.init();
  console.log('analytics-worker started');
}

bootstrap();
