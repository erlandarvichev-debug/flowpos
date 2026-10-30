# Полный backlog FLOWPOS ERP

82 задачи. DONE_LOCAL и DONE_SQL_FIXTURE подтверждают только локальный срез/SQL-проверки. Роли обозначают компетенцию, конкретные исполнители не назначены. S/M/L — относительный размер, не срок. Dependencies обязательны для production реализации; mock может развиваться независимо.

## FP-001 · Зафиксировать репозиторий и владельцев данных
Baseline | P0 | Tech lead | S | DONE_LOCAL
Зависимости: нет. Приёмка: HEAD проверен remote; карта вызовов и чужих изменений; изоляция checkout.

## FP-002 · Одна атомарная Rust-команда durable sale intent
POS | P0 | Rust engineer | L | PLANNED
Зависимости: FP-001. Приёмка: Один connection; fault injection и SQLITE_BUSY; одна полная операция; нет сети в SQL retry.

## FP-003 · Durable payment и fiscal state machines
POS | P0 | Backend/Rust | L | PLANNED
Зависимости: FP-002. Приёмка: UNKNOWN переживает restart; timeout не создаёт второй платёж/чек; проверен status lookup провайдеров.

## FP-004 · Canonical BackofficeProvider с capabilities
POS | P1 | Frontend/Backend | L | PLANNED
Зависимости: FP-001,FP-002. Приёмка: Нет обязательных oneCGUID/accountHref в домене; старые провайдеры проходят общий contract suite.

## FP-005 · Серверный inbox POS и stable operation identity
POS | P0 | Backend | M | PLANNED
Зависимости: FP-007,FP-008,FP-009,FP-004. Приёмка: UNIQUE tenant+org+operation; миграция устройства сохраняет sale; ACK после commit.

## FP-006 · Пилотная смена и сверка оборудования
POS | P0 | QA/Pilot owner | L | PLANNED
Зависимости: FP-003,FP-005. Приёмка: Продажа/возврат/смешанная оплата/печать/обрыв; ноль необъяснённых расхождений.

## FP-007 · Tenant и organization composite identity
Platform | P0 | Backend | M | DONE_LOCAL — см. `FP-007-TENANT-IDENTITY.md` (не выкладывалось; остаток — FP-008/FP-009)
Зависимости: FP-001. Приёмка: Два клиента и две организации не видят/не связывают чужие объекты.

## FP-008 · OIDC sessions RBAC grants и MFA
Platform | P0 | Security/Backend | L | DONE_LOCAL — см. `FP-008-SESSIONS-RBAC-MFA.md` (backend; экраны MFA/OIDC в вебе — нет; не выкладывалось)
Зависимости: FP-007. Приёмка: Revoke и expiry работают; org scope из session; field-level payroll permissions.

## FP-009 · Postgres unit of work outbox и RLS
Platform | P0 | Backend/DBA | L | DONE_LOCAL — см. `FP-009-RLS-UNIT-OF-WORK.md` (не выкладывалось)
Зависимости: FP-007. Приёмка: Runtime role без BYPASSRLS; rollback; composite FK; outbox после commit.

## FP-010 · Локальный синтетический ESF срез
ESF | P0 | Backend/Frontend | M | DONE_LOCAL
Зависимости: FP-001. Приёмка: Durable inbound/outbound/status/errors/dedup; UNKNOWN не resend; UI и signing boundary; тесты.

## FP-011 · Получить актуальный SDK WSDL XSD и доступ
ESF | P0 | Integration lead | M | PLANNED
Зависимости: FP-001. Приёмка: Bytes checksum version; test/prod service endpoints; onboarding auth TTL limits enums документированы.

## FP-012 · Адаптер получения и атомарный cursor
ESF | P0 | Integration engineer | L | PLANNED
Зависимости: FP-009,FP-011,FP-013,FP-021. Приёмка: Повтор страницы и crash не теряют документ; частичная страница не подтверждается; сверка диапазона.

## FP-013 · Реестр XML схем и immutable raw bytes
ESF | P0 | Backend/Security | M | PLANNED
Зависимости: FP-009,FP-011. Приёмка: Encoding/checksum сохранены; XXE/DTD отключены; unknown schema в карантине без потери полей.

## FP-014 · Сопоставление товара контрагента и оснований
ESF | P1 | Backend/Methodologist | M | PLANNED
Зависимости: FP-012,FP-025. Приёмка: Manual override audited; receipt не создаёт stock/VAT; correction chain сохранена.

## FP-015 · Serializer исходящего документа
ESF | P0 | Integration engineer | L | PLANNED
Зависимости: FP-011,FP-013,FP-029. Приёмка: Golden XML по XSD; версии формы; totals/rounding; no silent truncation.

## FP-016 · Signing provider и authority validation
ESF | P0 | Security/Signing engineer | L | PLANNED
Зависимости: FP-008,FP-011,FP-013. Приёмка: Exact bytes hash; сертификат/назначение/полномочия/expiry; stale approval блокируется; нет key в логах.

## FP-017 · Отправка и reconciliation результата
ESF | P0 | Integration engineer | L | PLANNED
Зависимости: FP-015,FP-016,FP-021. Приёмка: Lost response/restart → UNKNOWN; status lookup доказан; нет слепого resend.

## FP-018 · Решения по исправлению дополнению отзыву
ESF | P0 | Methodologist/Backend | M | PLANNED
Зависимости: FP-012,FP-016. Приёмка: Technical ACK отдельно от business acceptance; сроки/роль/основание; explicit approval.

## FP-019 · Частичный зачёт НДС и корректировки
ESF | P0 | Tax methodologist/Backend | L | PLANNED
Зависимости: FP-012,FP-039. Приёмка: Quarter/year/amount/remainder/rule version; нельзя автоматически зачесть весь VAT при download.

## FP-020 · Рабочее место ESF для реальных пользователей
ESF | P1 | Frontend | L | PLANNED
Зависимости: FP-008,FP-012,FP-017,FP-018. Приёмка: Tabs/filters/card/raw/history; UNKNOWN только сверка; partial bulk result; доступность клавиатурой.

## FP-021 · Jobs lease fencing retry и DLQ
Platform | P0 | Backend | M | PLANNED
Зависимости: FP-009. Приёмка: Stale worker не подтверждает чужой lease; jitter/Retry-After; unsafe stage не retry.

## FP-022 · Метрики и runbook ESF
ESF | P1 | SRE/Integration | M | PLANNED
Зависимости: FP-012,FP-017,FP-024. Приёмка: Alerts по lag/UNKNOWN/quarantine; trace и ответственный; secret redaction.

## FP-023 · Уполномоченный ESF sandbox pilot
ESF | P0 | QA/Methodologist | L | PLANNED
Зависимости: FP-017,FP-018,FP-019,FP-020,FP-022. Приёмка: Документы приняты реальным тестовым контуром; duplicate/correction/timeout доказательства; sign-off.

## FP-024 · Ошибки карантин и контролируемый replay
ESF | P1 | Backend/Support | M | PLANNED
Зависимости: FP-012,FP-017. Приёмка: Error taxonomy; причина исправления; audit replay; same key different hash не заметается.

## FP-025 · Товары варианты единицы штрихкоды
Catalog | P1 | Backend | M | PLANNED
Зависимости: FP-009. Приёмка: Stable item ID; дубли и weight barcode; versions и external mappings.

## FP-026 · Контрагенты договоры и реквизиты
Catalog | P1 | Backend/Frontend | M | PLANNED
Зависимости: FP-025,FP-008. Приёмка: Effective dates; адреса/БИН; доступ; нет чужих ссылок.

## FP-027 · Прайс-листы скидки и округление
Catalog | P1 | Backend | M | PLANNED
Зависимости: FP-025. Приёмка: Priority/interval; preview discount; immutable offline snapshot.

## FP-028 · Общие документы версии и ссылки
Documents | P0 | Backend | L | PLANNED
Зависимости: FP-009,FP-026. Приёмка: Expected_version; immutable posted version; source/correction graph; duplicate post conflict.

## FP-029 · Согласования и simulate command
Documents | P0 | Backend/Frontend | M | PLANNED
Зависимости: FP-028,FP-008. Приёмка: Hash/scope/sum/TTL bound; изменение отменяет approval; UI показывает эффект.

## FP-030 · Поступление и складские движения
Inventory | P1 | Backend | L | PLANNED
Зависимости: FP-025,FP-028. Приёмка: Частичная приёмка/расхождения; qty и value; источник каждого movement.

## FP-031 · Себестоимость и дополнительные расходы
Inventory | P1 | Accounting engineer | L | PLANNED
Зависимости: FP-030. Приёмка: Fixture COGS2200 profit800 stock8800; остаток округления детерминирован; метод периода.

## FP-032 · Резервы перемещения и адреса
Inventory | P1 | Backend/Frontend | M | PLANNED
Зависимости: FP-030. Приёмка: Available=fact-reserved; нет двойного резерва при конкуренции; two-stage transfer.

## FP-033 · Инвентаризация списание партии серии
Inventory | P1 | Backend/Frontend | M | PLANNED
Зависимости: FP-030,FP-031. Приёмка: Сверка с фактами; причины; lot/expiry; approved discrepancy.

## FP-034 · Заказ клиента отгрузка возврат
Sales | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-027,FP-028,FP-032. Приёмка: Partial fulfilment; return by basis; prices/tax snapshot; правильный склад/стоимость.

## FP-035 · Потребность заказ поставщику и приёмка
Purchases | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-026,FP-030,FP-029. Приёмка: Budget approval; qty expected/received; расхождения и возврат поставщику.

## FP-036 · Банк касса авансы и разнесение
Treasury | P1 | Backend | L | PLANNED
Зависимости: FP-028,FP-026. Приёмка: Bank key scoped by account; дубли не зачисляют дважды; allocation/reversal audited.

## FP-037 · Платёжный календарь и заявки
Treasury | P1 | Backend/Frontend | M | PLANNED
Зависимости: FP-036,FP-029. Приёмка: Согласование получателя/суммы; cash forecast scenarios; import не делает payout.

## FP-038 · Двойная запись и аналитики
Accounting | P0 | Accounting engineer | L | PLANNED
Зависимости: FP-028,FP-031,FP-036. Приёмка: Balanced entry; unique source/version; decimal rules; posting simulation accepted.

## FP-039 · Rule packs и налоговые регистры
Accounting | P0 | Tax methodologist | L | PLANNED
Зависимости: FP-038. Приёмка: Effective period/source/approval; воспроизводимость; golden tests не меняются под код.

## FP-040 · Закрытие периода и сторно
Accounting | P1 | Accounting engineer | L | PLANNED
Зависимости: FP-038,FP-039. Приёмка: Locked period enforced server; reopen audited; balance/stock reconciliation.

## FP-041 · ОС НМА амортизация и РБП
Accounting | P2 | Accounting engineer | L | PLANNED
Зависимости: FP-038,FP-040. Приёмка: Asset lifecycle; disposal; period rules; accepted reference dataset.

## FP-042 · Валюты курсы и переоценка
Accounting | P1 | Backend | M | PLANNED
Зависимости: FP-036,FP-038. Приёмка: Источник/дата курса; точные decimal; realized/unrealized difference; audit.

## FP-043 · P&L ДДС баланс и drilldown
Reports | P1 | Analytics/Frontend | L | PLANNED
Зависимости: FP-038,FP-040. Приёмка: Показатели раскрываются до документа; cutoff/currency/rule version; totals reconcile.

## FP-044 · Бюджеты проекты и план-факт
Reports | P2 | Analytics | M | PLANNED
Зависимости: FP-043,FP-037. Приёмка: CFO dimensions; plan snapshot; gap reason; access scoped export.

## FP-045 · Staging CSV Excel mapping и preview
Import | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-025,FP-026,FP-028. Приёмка: Row errors; dry run totals; idempotent batch; no external effects on import.

## FP-046 · Миграция 1С и МоегоСклада
Import | P1 | Integration engineer | L | PLANNED
Зависимости: FP-045,FP-005. Приёмка: Opening balances/delta/references; no duplicate sale after device migration; cutover ownership.

## FP-047 · Международный импорт и landed costs
Import | P1 | Methodologist/Backend | L | PLANNED
Зависимости: FP-030,FP-031,FP-039. Приёмка: Customs declaration/origin/currency/ТНВЭД; factual events separate; cost allocation accepted.

## FP-048 · Сотрудник договор и кадровые даты
Payroll | P1 | Backend/HR methodologist | M | PLANNED
Зависимости: FP-008,FP-026,FP-039. Приёмка: Role/field permissions; historical terms; no retroactive overwrite of payroll inputs.

## FP-049 · Графики табель отпуска больничные
Payroll | P1 | Backend/Frontend | M | PLANNED
Зависимости: FP-048. Приёмка: Effective dates; approved timesheet; absence overlap rules; source trace.

## FP-050 · Расчёт начислений удержаний и обязательств
Payroll | P1 | Payroll engineer | L | PLANNED
Зависимости: FP-048,FP-049,FP-039. Приёмка: Rule snapshot; exact rounding; period golden payslips accepted by methodologist.

## FP-051 · Утверждение перерасчёт payslip и реестр выплаты
Payroll | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-050,FP-037. Приёмка: Closed run immutable; adjustment trace; approval separate from real payout.

## FP-052 · Профиль обязанностей и календарь
Tax/ISNA | P1 | Tax methodologist | M | PLANNED
Зависимости: FP-039,FP-040. Приёмка: Forms/periods per org; source/effective dates; overdue ownership.

## FP-053 · Получить ИСНА контракты по нужным ФНО
Tax/ISNA | P1 | Integration lead | M | PLANNED
Зависимости: FP-052. Приёмка: Per-form access/schema/receipt/signing confirmed; no invented universal endpoint.

## FP-054 · Сборка ФНО контрольные соотношения и отправка
Tax/ISNA | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-053,FP-039,FP-016. Приёмка: Drilldown fields; immutable submission; final accepted receipt; correction history.

## FP-055 · Подтвердить НКТ contract и environments
NKT | P1 | Integration engineer | M | PLANNED
Зависимости: FP-025,FP-011. Приёмка: OpenAPI checksum auth/limits; test platform distinguished from productive NKT.

## FP-056 · Mapping NTIN KZTIN заявки и статусы
NKT | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-055,FP-025. Приёмка: Own stable ID; source/history; failed matching not silent; status reconciliation.

## FP-057 · Установить формы респондента и доступ
Statistics | P1 | Methodologist/Integration | M | PLANNED
Зависимости: FP-052. Приёмка: Для каждой формы XML/API/export подтверждён; general automation not assumed.

## FP-058 · Статформы validation package и receipt
Statistics | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-057,FP-016,FP-043. Приёмка: Период/форма/version; controls; submit status accepted; correction evidence.

## FP-059 · Межфирменные envelopes и архив подписей
EDO | P2 | Backend/Security | L | PLANNED
Зависимости: FP-013,FP-016,FP-029. Приёмка: Recipient grant; two independent tenants; signature evidence/retention/export.

## FP-060 · Лиды сделки воронки и активности
CRM | P1 | Backend/Frontend | L | PLANNED
Зависимости: FP-026,FP-034. Приёмка: Owner grants; stage history; deal→order→margin links; revenue not from stage alone.

## FP-061 · Коммуникации задачи и шаблоны
CRM | P2 | Integration/Frontend | M | PLANNED
Зависимости: FP-060,FP-008. Приёмка: Consent/access; dedup inbound; channel-specific failures; no unsolicited send.

## FP-062 · Policy engine A0-A3 и лимиты
Autopilot | P1 | Backend/Security | L | PLANNED
Зависимости: FP-008,FP-029,FP-043. Приёмка: Atomic reservations; stop/revoke; split commands cannot evade limits; UNKNOWN retains reserve.

## FP-063 · Помощник с доказательствами и draft actions
Autopilot | P1 | AI engineer | L | PLANNED
Зависимости: FP-062,FP-043. Приёмка: Org/time/source citations; prompt injection data isolation; no self approval.

## FP-064 · MCP read/draft/propose и OAuth
MCP | P2 | Backend/Security | L | PLANNED
Зависимости: FP-062,FP-063. Приёмка: Scopes/audience/revoke; no arbitrary SQL URL shell; client conformance pinned.

## FP-065 · Прогноз ДДС продаж и закупки
Forecast | P2 | Analytics | L | PLANNED
Зависимости: FP-043,FP-037,FP-060. Приёмка: Baseline/backtest/no future leakage; uncertainty; stockout/leadtime/cash constraints.

## FP-066 · Design system browser ERP и role nav
Frontend | P1 | Design/Frontend | M | PLANNED
Зависимости: FP-008. Приёмка: No Tauri in browser core; org/period visible; keyboard/focus/mobile table.

## FP-067 · Документ list/card/history и bulk results
Frontend | P1 | Frontend | M | PLANNED
Зависимости: FP-066,FP-028. Приёмка: Cursor/filter; field errors; conflict diff; partial success; permission-safe export.

## FP-068 · Threat model и boundary tests
Security | P0 | Security engineer | L | PLANNED
Зависимости: FP-008,FP-009. Приёмка: Tenant escape/IDOR/CSRF/SSRF/XXE; abuse cases and fixes; actual runtime role tests.

## FP-069 · Vault crypto key rotation и retention
Security | P0 | Security/SRE | M | PLANNED
Зависимости: FP-068. Приёмка: No secret in log/Git/LLM; encrypted backups; revoke drill; retention/legal hold.

## FP-070 · ПД география и передача LLM
Security | P0 | Legal/Security | M | PLANNED
Зависимости: FP-069. Приёмка: Утверждены размещение/backup/index/transfer legal basis и data minimization.

## FP-071 · Metrics traces logs и SLO
SRE | P1 | SRE | M | PLANNED
Зависимости: FP-009,FP-021. Приёмка: Lag/UNKNOWN/queue/ledger alerts; redaction; owner and escalation runbooks.

## FP-072 · Backup PITR restore drill
SRE | P0 | DBA/SRE | L | PLANNED
Зависимости: FP-069,FP-071. Приёмка: DB+objects+signatures восстановлены; measured RPO/RTO; checksum/link reconciliation.

## FP-073 · Golden financial and property suite
QA | P0 | QA engineer | L | PLANNED
Зависимости: FP-009,FP-028,FP-038. Приёмка: Fixture receipt/sale/cost; debit=credit; concurrent post; closed period; random replay.

## FP-074 · Browser E2E access and workflow
QA | P0 | QA/Security | L | PLANNED
Зависимости: FP-068,FP-020,FP-067. Приёмка: Org switch/tabs/stale approval/UNKNOWN/bulk; keyboard and screen reader check.

## FP-075 · Migration rehearsal и crash matrix
QA | P1 | QA/DBA | L | PLANNED
Зависимости: FP-072,FP-046. Приёмка: Expand/contract old/new clients; rollback/forward plan; disk full/BUSY/unknown commit.

## FP-076 · Load test пилотных объёмов
QA | P1 | Performance engineer | M | PLANNED
Зависимости: FP-071,FP-073. Приёмка: Измерены p95/error/queue; цели согласованы; test data synthetic; no production load.

## FP-077 · Разобрать dependency advisories baseline
Release | P0 | Tech lead/Security | M | PLANNED
Зависимости: FP-068. Приёмка: Четыре исходных advisories классифицированы; targeted upgrade+regression; no blind audit fix.

## FP-078 · CI supply chain и signing release artifacts
Release | P1 | Release engineer | M | PLANNED
Зависимости: FP-072,FP-075,FP-077. Приёмка: Type/schema/tests/secret scan/SBOM; separate env secrets; approved immutable artifact.

## FP-079 · Матрица готовности полного ERP
Release | P0 | Product/Methodologist | L | PLANNED
Зависимости: FP-006,FP-023,FP-040,FP-051,FP-054,FP-056,FP-058,FP-074. Приёмка: Каждый модуль/роль/сценарий имеет evidence/sign-off; ESF срез не объявлен всем ERP.

## FP-080 · Production go/no-go и pilot rollout
Release | P0 | Product/SRE | M | PLANNED
Зависимости: FP-078,FP-079,FP-070. Приёмка: Отдельное разрешение; tenant/org flags; rollback/kill switch; reconciliation owner.

## FP-081 · Fixture principal grants и lease fencing локального ESF
ESF access/concurrency | P0 | Backend/QA | M | DONE_LOCAL
Зависимости: FP-010. Приёмка: Scope из provider; org/action guard; шесть процессов; crash/restart; late callback fenced; UI карантина и read-only.

## FP-082 · ESF SQL migration restricted role RLS и concurrent claim
ESF PostgreSQL | P0 | Backend/DBA | M | DONE_SQL_FIXTURE
Зависимости: FP-081. Приёмка: Применение дважды; NOLOGIN/NOBYPASSRLS owner/runtime; реальные concurrent sessions и restart fixture cluster; HTTP PG adapter ещё не подключён.
