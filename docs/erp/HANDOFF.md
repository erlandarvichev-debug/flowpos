# Handoff · редакция 2.1

Весь исходный ERP scope сохранён; backlog 82 задачи. Этап 1: baseline и synthetic ESF. Этап 2: серверные grants, version/approval checks, SQLite migration v2, multi-process leases/fencing, UI карантина/read-only и отдельный PostgreSQL SQL slice.

HTTP runtime: Node 24.17 + SQLite; несколько процессов на одном локальном файле проверены, active leases сохраняются, expired→UNKNOWN без resend. Нет production scheduler/HA и отдельного PostgreSQL repository adapter. AuthProvider использует локальные fixtures, не OIDC и не credentials. Signing mock не является ЭЦП. Прямой ИС ЭСФ transport заблокирован CONTRACT_UNVERIFIED.

PostgreSQL: erp/postgres/001_esf.sql + 002_runtime_grants.sql; реальные RLS/command/concurrency/restart fixture tests отдельно от HTTP. Общий docs/erp/contracts/target-model.sql остаётся design-only для всего ERP и не является полной миграцией.

Читать STAGE2.md, CHANGELOG.md, ACCEPTANCE.md и evidence/STAGE2_VALIDATION.md. Не изменять работающую POS и чужие правки. FP-002 Rust atomic intent остаётся открытым. Разрешение на production/подпись/реальную отправку отсутствует.

Обновляются прежние Library IDs DOCX libfile_4ceaf36ad160819195399e4ff06005cb и ZIP libfile_6623e34eae3881918d9ea21215ed2ea1 с expected version 0. Исходные входные документы отдельно сохранены как lineage в SOURCES.md.
