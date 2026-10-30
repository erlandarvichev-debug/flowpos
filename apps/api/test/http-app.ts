// Настоящее приложение API для HTTP-тестов: как main.ts (NestFactory из @nestjs/core приложения —
// в корне монорепы другая мажорная версия Nest), случайный порт, запросы встроенным fetch.
import { randomUUID } from 'crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import * as bcrypt from 'bcryptjs';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

export const PASSWORD = 'пароль-e2e-123';
export const uid = () => randomUUID().slice(0, 8);

export interface HttpApp {
  app: INestApplication;
  prisma: PrismaService;
  base: string;
}

export async function startApp(): Promise<HttpApp> {
  // TEST_HTTP_LOG=1 — журнал Nest (ошибки 500 с причиной) при разборе падений.
  const app = await NestFactory.create(AppModule, { logger: process.env.TEST_HTTP_LOG === '1' ? ['error', 'warn'] : false });
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }));
  await app.listen(0, '127.0.0.1');
  return { app, prisma: app.get(PrismaService), base: await app.getUrl() };
}

export interface Res {
  status: number;
  body: any;
  text: string;
  /** Значение cookie из Set-Cookie, если сервер её поставил. */
  cookie: (name: string) => string | undefined;
}

export async function call(h: HttpApp, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; cookie?: string } = {}): Promise<Res> {
  const res = await fetch(`${h.base}/api/v1${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* не JSON */ }
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return {
    status: res.status, body, text,
    cookie: (name) => setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1),
  };
}

/** Пользователь с паролем PASSWORD в организации (и членство с ролью для бухгалтерии). */
export async function makeUser(h: HttpApp, tenantId: string, organizationId: string, opts: { role?: string; name?: string } = {}) {
  const email = `${(opts.name ?? 'u').toLowerCase()}-${uid()}@example.com`;
  const user = await h.prisma.user.create({
    data: { tenantId, organizationId, email, passwordHash: await bcrypt.hash(PASSWORD, 4), firstName: opts.name ?? 'Тест', lastName: 'HTTP' },
  });
  if (opts.role) await h.prisma.orgMembership.create({ data: { userId: user.id, organizationId, role: opts.role } });
  return { id: user.id, email };
}

export async function login(h: HttpApp, email: string, password = PASSWORD) {
  const res = await call(h, 'POST', '/auth/login', { body: { email, password } });
  return { res, token: res.body?.accessToken as string, refresh: res.cookie('fp_refresh') };
}

export { hashToken as hashTokenForTest } from '../src/modules/auth/auth.service';
