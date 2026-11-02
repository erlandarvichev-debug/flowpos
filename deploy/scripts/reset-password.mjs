#!/usr/bin/env node
/**
 * Сброс пароля пользователя на сервере (администратор потерял пароль / первичная смена).
 *   set -a; . /opt/flowpos/shared/api.env; set +a
 *   NEW_PASSWORD='…' node deploy/scripts/reset-password.mjs --email admin@company.kz
 * Пароль — только из переменной окружения (не в истории команд и не в списке процессов). Все сессии и refresh-токены
 * пользователя отзываются; действие пишется в журнал аудита.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const email = String(args.email ?? '').trim().toLowerCase();
const password = process.env.NEW_PASSWORD ?? '';
if (!email) { console.error('Укажите --email'); process.exit(1); }
if (password.length < 8) { console.error('NEW_PASSWORD: не короче 8 символов'); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url: process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL } } });
try {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) { console.error(`Пользователь ${email} не найден`); process.exit(1); }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10) } });
    await tx.authSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await tx.refreshToken.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.create({ data: { userId: null, organizationId: user.organizationId, action: 'PASSWORD_RESET_CLI', entity: 'user', entityId: user.id, after: { email } } });
  });
  console.log(`Пароль ${email} изменён; сессии отозваны.`);
} finally {
  await prisma.$disconnect();
}
