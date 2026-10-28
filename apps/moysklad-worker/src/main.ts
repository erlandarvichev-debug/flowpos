import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { MoyskladWorkerModule } from './moysklad-worker.module';

async function bootstrap() {
  const app = await NestFactory.create(MoyskladWorkerModule, { logger: ['log', 'warn', 'error'] });
  await app.init();
  console.log('moysklad-worker started');
}

bootstrap();
