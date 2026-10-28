import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

/** Боевой режим не стартует с небезопасной конфигурацией (иначе JWT подписывается общеизвестным ключом). */
function assertProductionConfig() {
  if (process.env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  const secret = process.env.JWT_SECRET || '';
  if (secret.length < 32 || secret === 'flowpos-secret') problems.push('JWT_SECRET не задан или короче 32 символов');
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL не задан');
  if (!process.env.CORS_ORIGIN) problems.push('CORS_ORIGIN не задан (адрес веб-интерфейса, https://…)');
  if (problems.length) {
    console.error(`FlowPOS API не запущен — небезопасная конфигурация:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
}

async function bootstrap() {
  assertProductionConfig();
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('FlowPOS API')
    .setDescription('Единая платформа управления торговлей, складом и персоналом')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  // В боевом режиме Swagger только по явному SWAGGER_ENABLED=1
  const swagger = process.env.NODE_ENV !== 'production' || process.env.SWAGGER_ENABLED === '1';
  if (swagger) {
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT || 3000;
  // За nginx слушаем только локальный адрес (HOST=127.0.0.1); по умолчанию — все интерфейсы, как раньше
  await app.listen(port, process.env.HOST || '0.0.0.0');
  console.log(`FlowPOS API запущен на http://localhost:${port}`);
  if (swagger) console.log(`Swagger: http://localhost:${port}/api/docs`);
}

bootstrap();
