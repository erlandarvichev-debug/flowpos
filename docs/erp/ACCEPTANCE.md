# Приёмка и пределы фактических проверок

## Дополнение редакции 2.1

Каждая команда повторно проверяет provider principal, tenant/org grants и действие; заголовки/тело не повышают права. Межорганизационные атаки, reader write, disabled/expired principal, missing expectedVersion и stale approval отклоняются. Несколько процессов создают один operation и одну попытку. Открытие второго store не сбрасывает active lease; hard crash и expiry приводят к UNKNOWN, callback старого lease fenced. Миграция v1 сохраняет bytes/hash/ID/cursor, отсутствующую историческую schema отмечает legacy-unrecorded.

PostgreSQL ESF slice проверяется отдельно на настоящем fixture cluster 16.9: RLS без bypass, composite FK, повтор применения, concurrent create/claim, version/hash/TTL и restart. HTTP PG adapter остаётся будущим этапом. Карантин сохраняет схему/оригинал, UI не предлагает approve/send; read-only scope не показывает mutation actions. Новые поля контракта и статусы см. OpenAPI 0.2.0, STAGE2.md и evidence/STAGE2_VALIDATION.md.

## Локальный синтетический ЭСФ срез

1. `npm run test:esf`: входящий replay оставляет один документ, другая версия имеет историю; ключ с изменённым hash даёт REMOTE_ID_CONFLICT, cursor не продвигается.
2. fault injection до cursor commit: нет частичной страницы/нового cursor; replay создаёт ровно одну запись.
3. Одинаковый operation_id + tenant/org + тело возвращает прежний исходящий; другое тело конфликтует. device_id не участвует в identity.
4. Просроченное approval или другой payload hash не может начать send. Signing mock обязательно содержит NOT_A_LEGAL_SIGNATURE и привязку к scope/hash/expiry.
5. Потеря ответа и crash в SENDING → UNKNOWN; повтор send не вызывает gateway. Reconcile не отправляет документ, только lookup.
6. Между tenant/org нет чтения/согласования по чужому ID. Local HTTP отвергает чужой Origin/Host и отсутствие локального token.
7. Неизвестная схема и XML с DTD/entity остаются в карантине; нет XML parsing, ledger posting, VAT credit, stock movement или business confirmation.
8. После рестарта файла SQLite сохраняются state и operation identity. Это тест процесса/БД, не физического отключения питания.

## Production ESF gate — все пункты обязательны

- Оператор подтвердил актуальный SDK, checksum, WSDL/XSD и тестовые endpoint.
- Организация прошла onboarding; подтверждены ClientID, auth/session, roles и signatory authority.
- Реальный signing provider и серверная проверка bytes hash/certificate/expiry приняты security и методологом.
- Подтверждены enums, business/technical states, send/status lookup, consistency delay, limits и dedup гарантии.
- Уполномоченный sandbox тест: потерянный ответ, сверка и отсутствие второго документа; повтор страницы/исправления/отзыв.
- RLS runtime role, composite FK, auth/RBAC, encrypted storage, immutable audit, backup restore и operational alarms проверены.
- Методолог принял фактический receipt/stock/VAT allocation и бизнес подтверждения; подписант принял юридический процесс.
- Pilot sign-off владельца и оператора; отдельное разрешение на production. В этом запуске его нет.

## ERP release gate

Golden dataset поступление/допрасходы/продажа даёт COGS 2200, прибыль 800, остаток 8800. Баланс проводок и складская оценка сходятся. Payroll воспроизводит утверждённые периоды/перерасчёт. Закрытие периода, импорт opening balances и recovery приняты. Каждая обязательная форма имеет accepted receipt либо точное объяснение её состояния. Ни прототип UI, ни зелёный build не означают готовность всей ERP.
