# Changelog

## 2.1 — этап 2, 27 октября 2026

- Server-owned fixture identity, отдельный AuthProvider/policy layer; права организации/действия проверяются на каждом запросе. Клиент не задаёт tenant или principal.
- Atomic SQLite v2 migration, composite FK approvals/jobs, schema version, optimistic version check, actor audit, bounded lease и fenced results.
- Реальная гонка WAL initialization обнаружена multi-process тестом и исправлена ранней установкой busy handler.
- Active send не восстанавливается открытием второго соединения; crash/expired lease → UNKNOWN без resend; stale callback игнорируется.
- UI: read-only организация, карантин/оригинал схемы, stale approval reset, стабильный ключ незавершённого создания, понятные ошибки.
- PostgreSQL ESF migration/RLS/command functions и disposable fixture test harness; отдельно от ещё не подключённого HTTP PG adapter.
- Повторная desktop-проверка официального SDK дала HTML portal, не архив. Live transport/signing остаются отключены.
- OpenAPI 0.2.0, 82 задачи backlog, обновлённые приёмка и runbook. Весь ERP scope сохранён.

## 2.0 — этап 1

Baseline и отдельный synthetic ESF stand, полная спецификация ERP, 80 задач, 230 POS и 13 ESF тестов. Commit 1a3b6153dfc5069523330dcbf0c173f040cf0f4b. Без push/PR/deploy.
