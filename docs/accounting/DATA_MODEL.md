# Модель данных (бухгалтерский контур)

Источник истины — `packages/db/prisma/schema.prisma` (раздел «БУХГАЛТЕРИЯ»). SQL-инварианты — `packages/db/prisma/sql/010_accounting_invariants.sql`.

## Организации и доступ
| Таблица | Назначение |
|---|---|
| `organizations` (+`legal_form`, `name_kk`) | ТОО/ИП; `inn` = БИН/ИИН |
| `org_memberships` | пользователь ↔ организация ↔ роль (несколько организаций, бухгалтерская фирма) |
| `acc_policies` | учётная политика с `valid_from`: плательщик НДС, налоговый режим, метод оценки запасов, отрицательные остатки, план счетов |
| `audit_log` (+`organization_id`, `reason`) | аудит существенных действий |

## План счетов
| Таблица | Назначение |
|---|---|
| `acc_charts` | версия плана (`code`, `version`, `valid_from/to`, источник) |
| `acc_accounts` | счёт/субсчёт: `kind` A/P/AP, `is_group`, `is_quantitative`, `is_currency`, `dims[]`, `required_dims[]`; `organization_id = null` — типовой, иначе субсчёт организации |

Аналитики (`dims`): COUNTERPARTY, CONTRACT, SETTLEMENT_DOC, PRODUCT, STORE, EMPLOYEE, DEPARTMENT, BANK_ACCOUNT, CASHBOX, PROJECT, ITEM → колонки `acc_postings`.

## Документы и движения
| Таблица | Назначение |
|---|---|
| `acc_documents` | документ: тип, номер (уникален в организации и типе), дата операции, статус DRAFT/POSTED/CANCELLED, `version`, автор, `body` (JSON содержимого по типу), `base_document_id`, `reversal_of_id`, внешние ключи обмена (`external_source`, `external_id` — уникальны) |
| `acc_document_versions` | неизменяемая история: версия, действие, снимок, кто, причина |
| `acc_entries` | регистратор движений: источник (`source_type/id/version`), правило (`rule_code/version`), статус ACTIVE/SUPERSEDED/CANCELLED |
| `acc_postings` | проводка-строка: `side` D/C, `ledger` BU/NU, счёт, сумма в ₸, валюта и валютная сумма, количество, аналитики, `is_active` |
| `acc_period_locks` | граница закрытого периода организации |
| `acc_number_sequences` | атомарная нумерация (организация, тип, год) |
| `idempotency_records` | ответы на запросы с `Idempotency-Key` |

## Справочники учёта
`currencies`, `currency_rates` (курс на дату, кратность, источник), `org_bank_accounts` (IBAN с проверкой mod-97), `cashboxes`, `acc_items` (статьи доходов/расходов/ДДС), `projects`, `vat_rates` (ставка с периодом действия, признак `verified`).

## Связь с торговлей и кадрами
- торговые справочники FlowPOS: `products`, `counterparties`, `contracts`, `stores`, `employees`, `departments` — используются как аналитики;
- HRMS (этап 4): `individuals`, `employment_contracts`, `employment_history` (bitemporal), `payroll_*`, `journal_entries` и др. — созданы, логика в работе.

## Хранение «проводка-строка по стороне»
Выбрана модель «строка = одна сторона» (а не пара Дт/Кт): поддерживает сложные проводки (один Дт — несколько Кт), инвариант Дт=Кт проверяется агрегатом по записи. Интерфейс ручной операции показывает привычные пары «Дт / Кт / сумма» и раскладывает их на две строки.
