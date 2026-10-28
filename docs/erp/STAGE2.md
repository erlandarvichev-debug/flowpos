# Второй инженерный этап · редакция 2.1

## Проверенный объём

Локальный runtime остаётся синтетическим. Добавлены отдельные AuthProvider и серверный policy layer: identity/tenant поступают от provider, организация выбирается только из grants, каждое действие проверяется заново. Фиксированный тестовый principal доступен только в локальном стенде, не является login/OIDC. Credentials и постоянные внешние полномочия не создаются. Переданный клиентом tenant/principal или лишнее поле команды отклоняется; заголовок организации не выдаёт право.

SQLite schema v2 мигрируется одной транзакцией. Approval/job имеют tenant+organization+document composite FK. У документа есть version, schemaVersion, lease token/expiry; approval связан с версией, hash, TTL и actor. Старые входящие получают schemaVersion=legacy-unrecorded: исходный этап не сохранял её, поэтому версия не выдумывается. Миграция не меняет payload/hash/operation identity. BUSY handler устанавливается до WAL/schema операций, что устраняет обнаруженную гонку открытия файла несколькими процессами.

Send claim атомарно потребляет approval и единственную попытку. Другой процесс сохраняет активное SENDING. Восстановление затрагивает только истёкший lease и переводит его в UNKNOWN; token обнуляется, старый callback не перезаписывает результат сверки. UNKNOWN не разрешает resend. Это не гарантия exactly-once внешнего портала: upstream contract пока неизвестен. Lease 60 секунд — параметр fixture, не рекомендация для production timeout. Истёкшее согласование возвращается в DRAFT отдельной разрешённой командой и проходит новое approval.

UI показывает разрешённые организации и read-only scope, причины ошибок и сохранённые поля неподдерживаемой формы. QUARANTINED не имеет кнопки согласования/отправки. Для UNKNOWN доступна только сверка. Незавершённое создание хранит operationId и тело в sessionStorage синтетического стенда; повтор/перезагрузка не меняют ключ. Это не credential storage. При конфликте версии UI обновляет журнал, ничего не отправляя автоматически.

## PostgreSQL — отдельно от HTTP runtime

erp/postgres/001_esf.sql и 002_runtime_grants.sql — исполняемый ограниченный ESF persistence slice, отдельно от общего проектного target-model.sql. Схема содержит organizations/grants/documents/approvals/attempts/audit, composite FK, operation uniqueness, state/version checks, command functions, RLS и revoke PUBLIC. Runtime не имеет прямого INSERT/UPDATE/DELETE; функции проверяют action/scope/hash/version/expiry и записывают audit. Owner и runtime тестируются без SUPERUSER/BYPASSRLS/LOGIN. FORCE RLS действует и для владельца функций; policies разрешают только нужные scoped операции. Отсутствующий trusted context даёт deny.

Тестовый harness использует PostgreSQL 16.9 в отдельном временном cluster, проверяет data_directory и fixture administrator до работы. Он не подключается к рабочей базе. Контекст app.tenant_id/app.principal_id должен устанавливать доверенный сервер после аутентификации; он не является защитой от злоумышленника, уже получившего прямой SQL runtime-доступ. NOLOGIN роли создаются только в disposable harness, не SQL-миграцией приложения.

SQL проверяется на реальном PostgreSQL: повтор миграции, реальные данные чужой организации/tenant, restricted roles, запрет прямого DML и команд reader, шесть конкурентных сессий create/claim, stale approval, составной FK, фактический restart, UNKNOWN/fencing. В HTTP пока не подключён PostgreSQL repository, нет полного worker scheduler, OIDC, production credential store или официального transport. Наличие SQL-тестов не означает готовность серверного ERP.

## SDK и оставшиеся блокеры

Новая desktop-проверка ссылки из официальной публикации КГД: esf-sdk-311225.rar → https://portal.kgd.gov.kz/kk/, HTTP 200, text/html, 129604 bytes, magic 3C21444F43545950452068746D6C3E0A. Архив и WSDL/XSD не получены. Повторных переборов старых URL не делалось; response не запускался. CONTRACT_UNVERIFIED остаётся обязательной блокировкой реальных подписей/отправок.

Следующий инженерный шаг: PostgreSQL repository adapter к текущему application layer, contract suite parity SQLite/Postgres, durable inbox/raw binary store и затем официальная test integration после SDK/onboarding. Независимый POS FP-002 durable Rust intent остаётся обязательным и не менялся в этом этапе. Полный ERP не готов; сохранён весь исходный scope и расширен единый backlog задачами FP-081/FP-082.
