import { NestFactory } from '@nestjs/core';
import { SyncWorkerModule } from './sync-worker.module';

async function bootstrap() {
  const app = await NestFactory.create(SyncWorkerModule, { logger: ['log', 'warn', 'error'] });
  await app.init();
  console.log('sync-worker started');
}

bootstrap();
