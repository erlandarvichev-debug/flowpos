# Аудит ночных коммитов 29.10: схема, миграции, сборка

**Дата:** 2026-10-29 · **Объём:** коммиты `0feaaad` (FP-007), `773544a` (FP-009), `625b4d2` (FP-002), `76cbfe9` (FP-003), `ead2ec9` (FP-004), `78cb1f6` (FP-005), `eb56569` (FP-021). Все сделаны ночью 28–29.10 моделью Claude (Haiku); в описаниях коммитов стоят «✅», которые не проверялись.

## Итог

**`main` сейчас нельзя собрать и выложить.** Сервер не пострадал: `deploy.sh` (`set -e`) собирает и проверяет схему до `db push` и до переключения `current`, поэтому выкладка остановится до любых изменений и сервер останется на прежнем релизе.

| Что | Состояние | С какого коммита |
|---|---|---|
| `schema.prisma` | **невалиден**: `prisma validate` даёт P1012, 1 ошибку на FP-007 и 3 начиная с FP-003. У `Document.tenant` нет обратного поля в `Tenant`; модель `Outbox` объявлена дважды (строки 306 и 2258); есть ссылки на несуществующую модель `PosSales` | `0feaaad` |
| Сборка API (`npm run build --workspace=apps/api`) | **падает** (exit 1): в `pos.service.ts` 56 синтаксических ошибок — методы `atomicSale` и далее оказались вне класса | `625b4d2` |
| Prisma-клиент и тестовая БД | сгенерированы и подняты из схемы **до** ночных коммитов (клиент от 23.10, в `flowpos_test` нет `tenant_id`, `tenants`, `jobs`). Поэтому все тесты, включая FP-014…FP-017, шли на старой схеме, а новую схему никто не применял | — |
| Unit-тесты `apps/api` | 18 падений в `auth`, `catalog`, `pos` были и **до** ночных коммитов. Набор `pos` теперь не компилируется вовсе. Ранее я ошибочно назвал 56 ошибок `tsc` в `pos.service.ts` «старыми» — они ночные | `625b4d2` |

## Миграции (`packages/db/prisma/migrations`)

**Выкладка их не использует:** `deploy.sh` делает `prisma db push` + `scripts/apply-sql.js` (`prisma/sql/*.sql`). Эти файлы ни разу не применялись ни к одной базе.

Чтобы проверить их на деле, я собрал чистую БД из схемы до ночных коммитов (`db push` + `prisma/sql`, как на сервере), добавил одну организацию и применил миграции по порядку, каждую в своей транзакции:

| Миграция | Результат |
|---|---|
| `20261028_add_tenant_isolation` | применяется: заполняет `default-tenant`. Но имена колонок `tenants` (`isActive`, `createdAt`) не совпадают с `@map` в схеме (`created_at`) |
| `20261029_add_postgres_rls_outbox_jobs` (FP-009) | `permission denied to create role`; без `CREATE ROLE` — `relation "outbox" already exists` |
| `20261029_fp002_atomic_pos_sale` | `syntax error at or near "BEGIN"` — триггер в синтаксисе SQLite |
| `20261029_fp003_payment_fiscal_state_machines` | `relation "pos_sales" does not exist` |
| `20261029_fp004_backoffice_provider` | применяется |
| `20261029_fp005_server_inbox_stable_operation` | `relation "pos_sales" does not exist` |
| `20261029_fp021_jobs_lease_fencing` | `relation "jobs" does not exist`; ниже — триггер в синтаксисе SQLite (`BEGIN … RAISE(ABORT …) END`), в PostgreSQL он не работает |

## Чего не касается

- Работа FP-010…FP-017 сама по себе корректна, но проверялась только на старой схеме. После исправления схемы её тесты нужно прогнать заново.
- FP-008 (OIDC/RBAC) и код в `apps/api/src/common/jobs`, `outbox`, `modules/backoffice`, `atomic-sale.rs` в этом аудите по существу не проверялись. Это следующая часть аудита.

## Сделано 30.10: откат (вариант 1)

Код, схема и миграции ночных коммитов возвращены к `8213659` одним коммитом (пересечений с FP-011…FP-017 нет):
`packages/db/prisma/schema.prisma`, 7 папок `packages/db/prisma/migrations/2026102*`, `apps/api/src/modules/pos/*`
(в т.ч. `atomic-sale.rs`, `pos.inbox.service.ts`), `apps/api/src/modules/auth/*` (FP-008, `oidc.service.ts`),
`apps/api/src/common/{guards/rbac.guard.ts,jobs/*,outbox/outbox.service.ts}`, `apps/api/src/modules/backoffice/*`,
`packages/shared-types/src/index.ts`, `.env.example`. FP-002…FP-009 и FP-021 — **PLANNED** (в `BACKLOG.csv` они и не менялись).

При проверке нашлись две поломки, которые были **ещё до ночи** (с первого коммита `a68d5bf`), и тоже исправлены:

- `accounting.controller.ts` импортировал `./payroll/payroll-export`, которого не существовало ни в git, ни в бэкапах
  (импорт добавлен 23.10, файл не был написан). Недописанный эндпоинт `GET payroll/:period/registry/:kind`
  (реестры ЗП для банка/ОПВ/СО/ОСМС в XLSX) **удалён**; фронт его не вызывал. Реестры — не сделаны, нужны форматы банков.
  Там же исправлен тип суммы в `PayrollService.createPayout`.
- `apps/web`: ключ `closing` в `useI18n.ts` объявлен дважды — `vue-tsc` падал, а в ОСВ и карточке счёта колонка
  «Сальдо на конец» показывалась как «Закрытие месяца». Пункт меню переименован в `monthClosing`.

Проверка после отката:

| Проверка | Результат |
|---|---|
| `prisma validate` | valid |
| Сборка как в `deploy.sh`: api, web, mcp, 4 воркера | все exit 0 |
| Юнит-тесты apps/api | 50 pass / 18 fail — те же 18 в catalog и pos, что и до ночи; набор pos снова компилируется |
| Интеграционные apps/api (`flowpos_test`) | 46 pass, 1 skip (живой стенд ИС ЭСФ, `ESF_LIVE=1`) |
| `npm run test:esf` | 230 / 230 |

Не проверено: `prisma db push` откаченной схемы на копии боевой БД (боевой БД ещё нет — сервер не развёрнут).

