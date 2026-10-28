# Этап 2: фактическая приёмка

Baseline этапа: 1a3b6153dfc5069523330dcbf0c173f040cf0f4b, та же изолированная ветка. Рабочая касса, её файлы и данные не менялись.

- Node suite: 23 теста (13 исходных + 10 access/concurrency/migration), включая шесть отдельных процессов, hard exit после durable claim, restart, fencing позднего ответа, cross-organization/tenant attacks, revoked/expired principal, stale version/approval, composite FK, upgrade schema v1→v2 и запрет read-only запросу восстанавливать чужую организацию.
- POS regression: 42 файла / 230 тестов PASS. App build и ESF typecheck PASS. Журналы stage2-* в evidence.
- PostgreSQL: отдельный временный PostgreSQL 16.9 cluster, NOLOGIN/NOSUPERUSER/NOBYPASSRLS runtime и owner, FORCE RLS, реальные чужие строки, повтор миграции, шесть concurrent sessions create/claim, FK, version/expiry, restart и late fencing. Итог только по evidence/stage2-postgres.json; HTTP runtime остаётся SQLite.
- UI: организации operator/read-only, неподдерживаемая форма→карантин→Детали с исходными полями; новая отправка→UNKNOWN→только сверка; reload сохраняет DB. Кнопки permission-aware, сервер проверяет права независимо.
- SDK: одна новая desktop-проверка официальной ссылки, HTTP200 HTML portal, 129604 bytes; это не RAR/WSDL/XSD. Реального API/подписи/отправки нет.

Multi-process тест обнаружил SQLITE_BUSY при WAL initialization до установки busy handler. Исправлен порядок PRAGMA, повтор прошёл. Windows restart harness потребовал раздельных control/server logfile: захват pipe и повторное открытие одного файла мешали запуску тестового PostgreSQL. Эти ошибки касались только disposable harness; production службы не трогались.

Ограничения: нет OIDC/production identity, внешних credentials, PG repository в HTTP, распределённого scheduler/HA, официального ESF adapter, crypto signing/certificate validation или полного ERP. Raw XML fixtures остаются UTF-8 строкой; production binary store спроектирован отдельно. Физическое отключение питания и hardware/fiscal pilot не проверялись.
