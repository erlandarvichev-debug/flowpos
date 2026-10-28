import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { PushWorkerModule } from './push-worker.module';

async function bootstrap() {
  const app = await NestFactory.create(PushWorkerModule, { logger: ['log', 'warn', 'error'] });
  await app.init();
  console.log('push-worker started');
}

bootstrap();
