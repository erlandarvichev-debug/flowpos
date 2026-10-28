# Запуск, тесты, резервное копирование

## Требования
Node.js 20+, PostgreSQL 16, Redis 7. На машине разработчика PostgreSQL и Redis запущены нативно (brew).

## Первый запуск
```bash
cd /Users/vipinet/FlowPOS
cp .env.example apps/api/.env        # и задать DATABASE_URL, JWT_SECRET
export DATABASE_URL="postgresql://flowpos:flowpos123@localhost:5432/flowpos?schema=public"
npm run db:push                      # схема Prisma + SQL-инварианты (packages/db/prisma/sql)
npm run dev                          # API :3000 (Swagger /api/docs) + веб :5173
```
При старте API загружает типовой план счетов, валюты, ставки НДС и учётную политику по умолчанию (идемпотентно).

> Схема БД ведётся через `prisma db push` (миграций нет). Любое изменение схемы: правка `packages/db/prisma/schema.prisma` → `npm run db:push`. Деструктивные изменения (удаление/переименование колонок) — только после бэкапа и с ручным SQL-скриптом переноса.

## Тесты
```bash
# одноразово: тестовая БД
psql -h localhost -d postgres -c "CREATE DATABASE flowpos_test OWNER flowpos"
cd packages/db && DATABASE_URL=postgresql://flowpos:flowpos123@localhost:5432/flowpos_test npx prisma db push --skip-generate && \
  DATABASE_URL=postgresql://flowpos:flowpos123@localhost:5432/flowpos_test node scripts/apply-sql.js
# интеграционные тесты бухгалтерского ядра (только на БД *_test)
npm run test:acc
```

## Резервное копирование
```bash
mkdir -p ~/FlowPOS-backups
pg_dump -h localhost -U flowpos -Fc flowpos > ~/FlowPOS-backups/flowpos-$(date +%Y%m%d-%H%M).dump
```
Рекомендуется ежедневно (cron/launchd) с хранением 30 дней + еженедельная копия вне сервера.

## Восстановление и его проверка
```bash
createdb -h localhost -O flowpos flowpos_restore_check
pg_restore -h localhost -U flowpos -d flowpos_restore_check ~/FlowPOS-backups/<файл>.dump
# контроль: ОСВ сходится и число активных проводок совпадает
psql -h localhost -U flowpos flowpos_restore_check -c \
 "SELECT ledger, SUM(CASE WHEN side='D' THEN amount ELSE -amount END) FROM acc_postings WHERE is_active GROUP BY ledger"
```
Ожидаемо: по каждому ledger сумма = 0. После проверки: `dropdb flowpos_restore_check`.

## Боевая установка
Комплект установки на сервер (systemd, nginx, бэкапы, откат) — [deploy/README.md](../../deploy/README.md).
