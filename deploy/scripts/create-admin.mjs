#!/usr/bin/env node
/**
 * Первичная настройка боевой базы: организация + первый администратор (вместо демо-seed с admin123).
 * Запуск на сервере из каталога релиза:
 *   set -a; . /opt/flowpos/shared/api.env; set +a
 *   node deploy/scripts/create-admin.mjs --email owner@company.kz --org "ТОО Компания" --bin 123456789012 \
 *        --first Имя --last Фамилия [--legal TOO|IP]
 * Пароль генерируется и печатается ОДИН раз — сменить после первого входа.
 * Повторный запуск с тем же e-mail ничего не меняет.
 */
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1]]] : a), []));
const need = ['email', 'org', 'bin', 'first', 'last'];
const miss = need.filter((k) => !args[k]);
if (miss.length) {
  console.error(`Не хватает параметров: ${miss.map((m) => '--' + m).join(' ')}`);
  process.exit(1);
}
if (!/^\d{12}$/.test(args.bin)) { console.error('БИН/ИИН — 12 цифр'); process.exit(1); }
const email = args.email.trim().toLowerCase();

const prisma = new PrismaClient();
try {
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    console.log(`Пользователь ${email} уже есть — ничего не меняю.`);
    process.exit(0);
  }
  // Системные роли старого модуля прав (как в seed), без демо-данных
  const roles = [['admin', 'Администратор', true], ['manager', 'Менеджер', false], ['cashier', 'Кассир', false], ['hr', 'HR-менеджер', false]];
  for (const [name, displayName, isSystem] of roles) await prisma.role.upsert({ where: { name }, create: { name, displayName, isSystem }, update: {} });
  const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });

  const password = randomBytes(12).toString('base64url');
  const result = await prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({ data: { name: args.org, inn: args.bin, legalForm: args.legal || 'TOO' } });
    const user = await tx.user.create({ data: { email, passwordHash: await bcrypt.hash(password, 10), firstName: args.first, lastName: args.last, organizationId: org.id } });
    await tx.userRole.create({ data: { userId: user.id, roleId: adminRole.id } });
    await tx.orgMembership.create({ data: { userId: user.id, organizationId: org.id, role: 'owner' } });
    await tx.auditLog.create({ data: { userId: null, organizationId: org.id, action: 'BOOTSTRAP_ADMIN', entity: 'user', entityId: user.id, after: { email, organization: args.org } } });
    return { org, user };
  });
  console.log('Готово.');
  console.log(`  Организация: ${result.org.name} (БИН ${result.org.inn})`);
  console.log(`  Вход:        ${email}`);
  console.log(`  Пароль:      ${password}   ← показывается один раз, смените после входа`);
} finally {
  await prisma.$disconnect();
}
