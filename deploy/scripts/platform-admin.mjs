#!/usr/bin/env node
/**
 * Администратор платформы (раздел «Платформа»: все организации и их подписки на решения).
 * Запуск на сервере из каталога релиза:
 *   set -a; . /opt/flowpos/shared/api.env; set +a
 *   node deploy/scripts/platform-admin.mjs --email owner@company.kz          # назначить
 *   node deploy/scripts/platform-admin.mjs --email owner@company.kz --remove # снять
 *   node deploy/scripts/platform-admin.mjs --list                            # кто назначен
 * Пользователь с этим e-mail должен уже существовать (входить на сайт). Повторный запуск ничего не меняет.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');

const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const has = (name) => argv.includes(`--${name}`);

// Служебная таблица под RLS читается только системным режимом — работаем под владельцем БД, как create-admin.
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) { console.error('Нет MIGRATION_DATABASE_URL/DATABASE_URL — загрузите api.env'); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url } } });

try {
  if (has('list')) {
    const rows = await prisma.platformAdmin.findMany({ orderBy: { createdAt: 'asc' } });
    const users = await prisma.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, email: true } });
    if (!rows.length) console.log('Администраторов платформы нет.');
    for (const r of rows) console.log(`  ${users.find((u) => u.id === r.userId)?.email ?? r.userId}  (с ${r.createdAt.toISOString().slice(0, 10)})`);
    process.exit(0);
  }
  const email = (arg('email') || '').trim().toLowerCase();
  if (!email) { console.error('Укажите --email (или --list)'); process.exit(1); }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, organizationId: true } });
  if (!user) { console.error(`Пользователь ${email} не найден — сначала он должен быть заведён на сайте`); process.exit(1); }
  if (has('remove')) {
    const { count } = await prisma.platformAdmin.deleteMany({ where: { userId: user.id } });
    if (count) await prisma.auditLog.create({ data: { userId: null, organizationId: user.organizationId, action: 'PLATFORM_ADMIN_REMOVED', entity: 'user', entityId: user.id, after: { email } } });
    console.log(count ? `${email} больше не администратор платформы.` : `${email} и так не администратор платформы.`);
  } else {
    const exists = await prisma.platformAdmin.findUnique({ where: { userId: user.id } });
    if (exists) { console.log(`${email} уже администратор платформы — ничего не меняю.`); process.exit(0); }
    await prisma.platformAdmin.create({ data: { userId: user.id, note: 'deploy/scripts/platform-admin.mjs' } });
    await prisma.auditLog.create({ data: { userId: null, organizationId: user.organizationId, action: 'PLATFORM_ADMIN_ADDED', entity: 'user', entityId: user.id, after: { email } } });
    console.log(`Готово: ${email} — администратор платформы. Раздел «Платформа» появится после повторного входа на сайт.`);
  }
} finally {
  await prisma.$disconnect();
}
