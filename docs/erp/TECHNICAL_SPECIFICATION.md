# FLOWPOS ERP
## Техническая спецификация 2.1 · 27 октября 2026

Назначение: собственная браузерная бухгалтерия и управление бизнесом Казахстана. Полный целевой продукт включает торговлю, закупки, склад, управленческий и бухгалтерский учёт, CRM, кадры, зарплату, импорт, налоги, статистику, ЭДО, MCP и управляемый автопилот. 1С и МойСклад служат функциональными ориентирами и переходными интеграциями. Новое ядро не требует их наличия. Рабочая касса сохраняет свой текущий контракт до отдельного приёмочного перехода.

Первый инженерный срез: входящие и исходящие ЭСФ, статус, ошибки, дедупликация, долговечное состояние и безопасная граница подписи. В этом выпуске реализован локальный синтетический стенд, а не промышленный обмен ИС ЭСФ. Полнота ERP не определяется завершением одного среза.

### Статусы реализации

Реализовано локально: отдельный Node/TypeScript модуль, синтетический gateway, SQLite WAL/FULL со schema v2, version/approval/hash/TTL, составные FK, lease/fencing, одна попытка отправки, UNKNOWN и сверка. AuthProvider отделён от серверной проверки grants организации/действия. UI поддерживает read-only организацию, карантин с исходными полями и стабильный повтор создания. PostgreSQL ESF SQL-миграция проверяется отдельно на реальном временном PostgreSQL 16.9; HTTP repository пока SQLite. Существующие POS маршруты, sale.service.ts, оборудование и фискализация не менялись.

Спроектировано, ещё не реализовано: полный PostgreSQL ERP и его HTTP repository adapter, производственная многопользовательская аутентификация, полномочия подписанта, реальная подпись, официальный SOAP/XML контракт, автоматический опрос порталов, бухгалтерские проводки, зарплата и прочие модули backlog. Проектные DDL/API в комплекте не являются применённой production миграцией.

### Состав самодостаточного пакета

TECHNICAL_SPECIFICATION.md, REPOSITORY_BASELINE.md, BACKLOG.csv и BACKLOG.md, contracts/esf-stand.openapi.json, contracts/target-model.sql, ACCEPTANCE.md, SOURCES.md, LOCAL_RUNBOOK.md, исходники erp/esf-stand и фактические журналы evidence. Идентификаторы задач унифицированы как FP-001 и далее. Историческое FP-00 соответствует FP-001, FP-01 — FP-002, FP-02 — FP-003, FP-03 — FP-004, FP-04 — FP-005, FP-05 — FP-006.

## 1. Пользователи, организации и границы продукта

Роли: владелец бизнеса, бухгалтер, методолог, продажи, закупки, кладовщик, кассир, кадровик, расчётчик, администратор организации, инфраструктурный администратор, аудитор и агент. Tenant изолирует клиента сервиса; организация обозначает юридическое лицо внутри tenant. Один пользователь получает grants по организациям, подразделениям и действию. Видимость поля зарплаты не следует из права на общий справочник сотрудников.

Основная навигация: Главная, Продажи, Закупки, Склад, Деньги, Бухгалтерия, Зарплата, CRM, Документы/ЭСФ, Отчётность, Автопилот, Настройки. Организация, период и актуальность данных видны постоянно. Смена организации сбрасывает текущую выборку и не переносит выделенные документы. Параллельная вкладка проверяет серверную область на каждой команде.

Ключевые пользовательские цепочки: заказ поставщику → фактическое поступление → дополнительные расходы → расчёт себестоимости → продажа → оплата → проводки → отчёт; сотрудник → договор → табель → расчёт → проверка → утверждение → платёжное поручение; исходящий документ → проверка → согласование → подпись → отправка → регистрация/отказ/сверка; входящий ЭСФ → сопоставление → проверка → отдельное решение о хозяйственном документе и налоговом учёте.

## 2. Архитектура и backend

Цель — TypeScript modular monolith + PostgreSQL. Начальное разбиение по модулям: Identity/Tenancy, Organizations, Catalog, Documents, Inventory/Costing, Sales/Purchases, Treasury, Accounting, Payroll, CRM, Tax/Reporting, Integrations, EDO/Signing, Automation/MCP. Приложение использует общий command/query слой; HTTP, фоновые задания и MCP вызывают одинаковые use cases. Зависимости направлены от адаптеров к прикладному слою и домену. Модуль не пишет чужие таблицы напрямую.

Команда валидирует вход, права, период, expected_version и лимит; внутри одной транзакции сохраняет агрегат, движения и outbox; после commit возвращает подтверждение. Внешняя сеть никогда не находится внутри повторяемой SQL транзакции. Файлы помещаются в immutable object storage с hash, size, media type, tenant и retention policy. Сначала durable staging и антивирус, затем привязка; уборка бесхозных объектов имеет grace period.

Очередь первоначально на PostgreSQL jobs/outbox с SELECT FOR UPDATE SKIP LOCKED, lease_until, lease_owner, attempt, next_run_at и fencing_version. Потерявший lease worker не подтверждает результат новой версии. Сетевая доставка at least once; один бизнес эффект обеспечивает БД и проверенная идемпотентность внешней стороны. После неизвестного commit читается operation_id, а не повторяется вся цепочка.

Событие содержит event_id, tenant_id, organization_id, aggregate_id, aggregate_version, event_type, schema_version, occurred_at, correlation_id, causation_id и payload. Inbox уникален по consumer и event_id. Порядок важен внутри агрегата; поздняя версия не перезаписывает более новую. События не дублируют без необходимости ПД и полный XML. Длинная операция отвечает 202/job_id, статус и отмена имеют отдельный ресурс.

## 3. Модель данных и инварианты

Базовые группы: tenants, legal_entities, users, memberships, roles, grants, devices; parties, contracts, items, variants, units, barcodes, external_mappings; documents, document_lines, document_links, snapshots; stock_movements, reservations, cost_layers, cost_allocations; journal_entries, journal_lines, accounts, dimensions, periods; bank_accounts, bank_transactions, allocations, payment_attempts; employees, employment_terms, timesheets, payroll_runs, payslips; rule_packs, tax_registers, report_versions, receipts; integration_connections, inbox, outbox, jobs, attempts; esf_documents, esf_versions, raw_artifacts, signatures, approvals, audit.

Каждая tenant-таблица имеет tenant_id. Ссылка включает tenant_id и id; для хозяйственных объектов также organization_id. UUID внешнего документа не даёт право читать чужой tenant. Уникальность исходящей операции: tenant_id + organization_id + operation_id. device_id служит происхождению и не входит в дедупликацию продажи: замена кассы или миграция устройства не создаёт новую продажу. Старые локальные id переносятся через migration mapping с уникальностью legacy_device_id + legacy_local_id, сохраняя один canonical operation_id.

Входящий ЭСФ: tenant + organization + connection + external_document_id + external_revision. Регистрационный номер документа не предполагается глобально уникальным без доказательства оператора. Получены те же байты — replay без нового эффекта; тот же ключ, другой hash — конфликт и остановка cursor/задача оператору; новая версия — новая immutable версия со связью correction_of. Оригинальные bytes, encoding, media type, schema namespace, schema version, checksum, время и источник сохраняются до декодирования. Canonical projection не заменяет оригинал.

Деньги в API передаются decimal strings в minor units или точным decimal с currency/scale; JS Number и float не используются для проводок. Количество NUMERIC(24,6), стоимость NUMERIC(24,6), итог NUMERIC(24,2) с документированным округлением. Проводка балансирует дебет и кредит в каждой валюте/оценке; posted snapshot неизменяем, изменение оформляется сторно и новым документом. Период закрывается с серверной блокировкой; задняя дата проходит разрешённое открытие периода с аудитом.

## 4. Учётное ядро и контрольный пример

Правила проведения версионируются по виду документа, организации и effective period. Симуляция показывает складские, денежные, налоговые и бухгалтерские последствия до проведения. Повтор проведения той же версии не создаёт второй набор движений. Контроль остатков учитывает резервы, партии, серии, отрицательный остаток и допустимую стратегию оценки. Политика FIFO/средняя выбирается для организации и периода; изменение не переписывает закрытую историю без регламентной переоценки.

Контрольная fixture: поступление 10 единиц по 1000 ₸, дополнительные расходы 1000 ₸ распределены на все единицы. Себестоимость единицы 1100 ₸. Продажа 2 × 1500 ₸ даёт выручку 3000 ₸, COGS 2200 ₸, валовую прибыль 800 ₸ и остаток 8 единиц на 8800 ₸. Расходы распределяются детерминированно, остаток округления закрепляется устойчивым правилом. НДС, комиссии и прочие расходы в этом примере не заданы и не подразумеваются. Приход ЭСФ сам по себе не запускает этот сценарий.

Управленческие отчёты: P&L, ДДС, баланс, валовая маржа, оборачиваемость, долги и план-факт. Каждый итог раскрывается до движений и документа. У отчёта сохраняются период, организация, валюта, правила пересчёта, версия методики, cutoff и время обновления. Управленческая прибыль и бухгалтерская/налоговая база имеют явное назначение и отдельные reconciliation bridges.

## 5. Торговля, закупки, склад и импорт

Продажи: предложения, заказы, резервирование, подбор/отгрузка, частичное исполнение, доставка, счета, возвраты по основанию, скидки и прайс-листы. Покупки: потребность, заказ, согласование бюджета, ожидаемое поступление, приёмка с расхождениями, допрасходы, возврат поставщику. Импорт внешних данных из 1С/МойСклад/CSV проходит staging → validation → mapping → preview → approval → apply → reconcile; отчёт по каждой строке и контрольным итогам обязателен.

Импорт товаров международной торговли хранит декларацию, страну происхождения, код ТН ВЭД, партию, валюту, курс, таможенные и транспортные расходы, документы СНТ/виртуального склада при применимости. Факт таможенного выпуска, приход на склад и ЭСФ — отдельные события. Методолог подтверждает правила конкретного режима. Ошибки кодов/единиц не исправляются эвристикой без следа; создаётся задача сопоставления.

Склад поддерживает несколько складов, адреса, перемещения, инвентаризацию, списания, сборку/разборку по спецификации, партии/серии и сроки годности. Складской остаток и стоимость сверяются с бухгалтерией после каждого закрытия. Массовый импорт не запускает реальные отправки и подписи, пока это не включено отдельной проверенной политикой.

## 6. POS, офлайн и надёжная миграция

Касса остаётся Vue/Tauri/Rust/SQLite. До внешней оплаты и фискализации должна появиться одна Rust-команда: нормализовать snapshot → BEGIN на одном connection → вставить operation/чек/строки/ожидаемые оплаты/recovery job → COMMIT. UNIQUE(operation_id) и payload_hash возвращают существующий документ либо conflict. SQLITE_BUSY повторяется только для гарантированно откатившейся транзакции. Ошибка после commit требует чтения по operation_id. Отдельные JS BEGIN/INSERT/COMMIT через пул не являются исправлением.

Payment attempt и fiscal attempt имеют независимые CREATED/STARTED/CONFIRMED/REJECTED/UNKNOWN/RECONCILING состояния. Факт получения денег не определяется статусом экспорта в ERP. Timeout означает UNKNOWN; повтор допустим только при подтверждённом отсутствии эффекта либо проверенной upstream идемпотентности. Восстановление по durable intent, сохранённому до эффекта. Существующие posSyncId, completeness guard и TerminalPaymentUncertainError сохраняются до доказанной замены.

FlowErpBackofficeProvider получает канонические product_id, party_id и money, capabilities, typed errors, reconciliation. oneCGUID/accountHref остаются в legacy mapping, а не обязательных ERP DTO. Переключение по feature flag на организацию/точку с read-only shadow comparison. Для каждой сущности назначен один writer; двойная автоматическая запись одной продажи в оба backoffice запрещена. Этот этап пока backlog FP-002…FP-006, а не часть локального ESF patch.

## 7. ЭСФ inbound

Планировщик выбирает подключение организации, проверяет доступ и rate limit, получает страницу через verified adapter, сохраняет исходные файлы, immutable версии и inbox, затем cursor в одной транзакции. Cursor продвигается после durable commit всех элементов; crash до commit допускает повтор страницы. Используются перекрывающееся окно по времени и дедуп, когда официальный контракт не гарантирует стабильный cursor. Внешние даты нормализуются с сохранением оригинального значения/offset. Ретроспективная полная сверка по диапазону имеет отдельный job.

Внутренние этапы: downloaded → schema_validated либо quarantined → normalized → matched → review_required. Статус портала хранится raw и canonical; неизвестное значение не становится REGISTERED. Сопоставление контрагента, товара, единиц, НКТ, договора и основания имеет confidence и manual decision. Нельзя создавать stock receipt, debit/credit или полный VAT credit только потому, что ЭСФ получен. Такие действия оформляются отдельной командой со snapshot и правами.

Исправление, дополнительный документ и отзыв имеют цепочку и историю. Техническое подтверждение скачивания/доставки не означает юридическое согласие получателя. Принятие/отклонение и срок для конкретного вида документа проверяются методологом и подписантом; autopilot не выбирает автоматически «принять» при скачивании. При unknown schema сохраняется весь оригинал, документ в карантине и alert; поля не обрезаются молча.

## 8. ЭСФ outbound и статусы

Черновик собирается из принятого хозяйственного основания. Валидация проверяет обязательные поля, итоги/округление, идентификаторы сторон, версию формы и связь исправления. Запрещено подписывать mutable record. Сохраняются immutable submission_version, canonical hash, конкретные wire bytes и wire hash. Согласование связывает организацию, действие, document_version, hash, сумму, подписанта и TTL. Любое существенное изменение отменяет согласование и подпись.

Целевая машина: DRAFT → VALIDATED → APPROVAL_PENDING → APPROVED → SIGN_PENDING → SIGNED → QUEUED → SENDING → REGISTERED/REJECTED/UNKNOWN. Состояния signing, technical delivery, business acceptance и accounting posting моделируются раздельно. До сети сохраняется попытка и submission key. После ответа сохраняются raw response, remote id, status, timestamps и trace. HTTP 200 сам по себе не доказывает регистрацию. Формальный success определяется только подтверждённым контрактом ответа и проверкой статуса.

UNKNOWN блокирует новую отправку той же версии. Reconciliation запрашивает статус по доказанному ключу/remote id и сравнивает hash/реквизиты. Если результат не найден, это ещё не обязательно разрешение на повтор: нужны гарантии консистентности и задержек оператора. При отсутствии такого метода задача остаётся оператору. Истёкший lease не доказывает неотправку. RETRYABLE относится к доказанному безопасному этапу, например получению страницы, а не ко всей цепочке.

## 9. Signing, ЭЦП и полномочия

Провайдер подписи получает request_id, tenant/org, document/version, action, exact bytes reference, bytes_hash, format/profile, certificate policy и expiry. Он возвращает отдельный immutable artifact и проверяемые доказательства. Backend снова проверяет hash, версию, срок, назначение сертификата, принадлежность и полномочия подписанта. User approval и криптографическая подпись — разные ресурсы. При недоступной проверке certificate/OCSP/CRL статус verification_pending, а не valid.

В стенде реализован SyntheticSigningProvider с маркером NOT_A_LEGAL_SIGNATURE и проверкой binding; ключи не читаются, NCALayer не вызывается. Реальный профиль XML canonicalization, algorithm, signature placement, session authentication и формат ответа остаются CONTRACT_UNVERIFIED до получения актуального SDK. Названия внутренних send/lookup/sign не выдаются за официальные API методы.

Для рабочего доступа нужны отдельные полномочия организации, договор/онбординг, законная схема подписи и утверждённый класс автоматизируемых действий. Ключ и пароль не хранятся в браузере, Git, журнале или LLM контексте. Архив сохраняет исходные bytes, подпись, сертификат, цепочку проверки, evidence time и квитанции. Автономная подпись директора общей настройкой автопилота не включается.

## 10. Четыре государственных контура

ИС ЭСФ: первый приоритет; receive/send/status/errors/dedup/signing boundary. Опубликованы несколько SDK-кандидатов; актуальность production и transport contract не подтверждены. ИСНА: профиль организации и календарь ФНО, версия формы, контрольные соотношения, package, подпись, отправка и финальная квитанция; доступ и API проверяются для каждой формы. НКТ: локальный stable item_id плюс NTIN/KZTIN и источник mapping; тестовая платформа не считается продуктивом. Статистика: формы и периоды респондента, XML/export или API только при подтверждённой поддержке конкретной формы, receipts и исправления.

Для всех адаптеров одинаковый evidence registry: источник, дата, version/checksum, endpoint environment, auth, scope, лимиты, контракт ошибок, retry semantics, статус последней сверки, владелец и support runbook. Чтение публичной страницы не подтверждает подключение аккаунта. Общий UI порталов показывает доступность и последнее успешное действие раздельно по организации.

## 11. Деньги, бухгалтерия, зарплата и отчётность

Treasury: кассовые ордера, банк import/feed, разнесение, взаиморасчёты, авансы, валюта, курсовые разницы, планы платежей и контроль дублей по банковскому счёту и внешнему ключу. Реальные выплаты не происходят при импорте файла. Двойное согласование и лимиты применяются к платежам отдельно от права читать банк.

Бухгалтерия: план счетов, аналитики, журналы, ОС/НМА, амортизация, расходы будущих периодов, резервы, взаиморасчёты, сверки и закрытие месяца/года. Методолог принимает типовые операции и справочник налоговых правил. Зарплата: сотрудник и договор с effective dates, ставки/график, кадровые события, табель, отпуска/больничные, начисления, удержания, обязательства работодателя, перерасчёт, payslip и реестр выплаты. Формулы, пороги и ставки не зашиты в UI: rule_pack содержит period, источник, статус approval и тестовый набор; воспроизводимость расчёта обязательна.

Отчётность: профиль обязанности организации, календарь, версия ФНО/статформы, заполняемые поля, контрольные соотношения, расшифровка до регистра, snapshot отправки, подпись, квитанции и исправления. Успех transport не заменяет статус accepted. Частичное отнесение НДС в зачёт хранит период/год, распределённую сумму, остаток, основание, метод и версию правила. Последующая корректировка не переписывает прошлую запись без истории. Налоговые ставки и юридические сроки требуют актуализации перед выпуском, в этом проекте нет вычисленного рабочего налогового профиля.

## 12. CRM, автопилот и MCP

CRM: лид/контакт/компания, воронка, сделки, активности, задачи, коммуникации, документы и фактическая маржа. Контактные данные и сообщения доступны только в области полномочий. Закрытая сделка не превращается автоматически в доход или гарантированный cash flow. Прогноз хранит горизонт, train cutoff, backtest, baseline, ошибку и интервал неопределённости; нехватка истории даёт сценарии, а не выдуманную точность.

Автопилот A0 читает/объясняет, A1 готовит черновики, A2 выполняет утверждённые внутренние правила с лимитом, A3 требует конкретного одобрения для внешних/юридических действий. Policy содержит субъекта, организации, действия, source allowlist, лимиты на операцию/период, expiry и stop switch. Лимит резервируется атомарно вместе с исполнением; несколько агентов и дробление команд не обходят потолок. UNKNOWN удерживает резерв до сверки. Документ и вложение являются недоверенными данными, их текст не меняет права.

MCP предоставляет search_documents, get_document, get_stock, explain_report, draft_document, simulate_posting, propose_action, get_action_status; execute_action появляется только после серверной проверки prepared action. OAuth scope не заменяет разрешение организации, лимиты и expected_version. API/MCP не принимают произвольный SQL, URL, shell или путь файла. Инструменты агента не получают доступ к ключам и production секретам. Отзыв доступа распространяется на кэш и search index.

## 13. Frontend и рабочее место ЭСФ

Целевой frontend — Vue 3 + TypeScript, отдельная browser ERP сборка; текущая POS сборка остаётся независимой. Общие компоненты design system, typed API client и i18n используются без импорта Tauri в браузерное ядро. Responsive desktop/tablet layout, клавиатура, заметный focus, semantic table, role/status и screen reader labels обязательны. Даты показывают timezone, деньги currency/scale, pending/offline/error имеют разные подписи.

ЭСФ UI: вкладки Входящие/Исходящие/Требуют решения/Ошибки; фильтры org, период, направление, контрагент, remote/canonical state, error code. Строка открывает карточку: реквизиты, строки, исходный файл, schema version/hash, история версий, correction linkage, сопоставления, статус подписи/доставки/решения и audit timeline. На UNKNOWN есть «Сверить статус» и инструкция, слепой «Отправить снова» скрыт. Массовое действие показывает количество, общий эффект и ошибки по элементам; partial success не маскируется одним зелёным toast.

Согласование показывает конкретные bytes preview, организацию, сумму, тип действия, подписанта и expiry. Редактирование аннулирует старое approval. Кнопки disabled объясняют причину: доступ, period lock, expired signing или unverified contract. Stand UI отображает синтетический режим постоянно и не предлагает реальные ключи. Его principal фиксирован provider на сервере; организация и действие ограничены grants, 200 строк без production пагинации. Это прототип без production identity provider.

## 14. API и обработка ошибок

Целевой ERP API /api/v1, token auth/OIDC, scope из trusted session, tenant/org не принимаются как расширение доступа. POST commands требуют Idempotency-Key, updates/transition — If-Match/expected_version. Повтор того же key/body после проверки прав возвращает прошлый результат; другой body — 409 DUPLICATE_PAYLOAD_CONFLICT. Стандарт ошибки: code, message, trace_id, retryable, field_errors, details без секретов. Пагинация — opaque cursor с фильтрами и sort key; курсор не даёт доступ за пределы scope.

Планируемые ресурсы: /organizations, /catalog/items, /documents, /documents/{id}/simulate, /post, /reverse, /payments, /inventory, /reports, /payroll/runs, /integrations/connections, /esf/inbound/sync-jobs, /esf/documents, /esf/documents/{id}/versions, /approvals, /signing-requests, /submissions, /reconciliations, /business-decisions. Это проектные маршруты, ещё не реализованные API.

В комплекте точный OpenAPI локального стенда: GET /api/session, GET /api/documents; POST /api/fixtures/inbound, /api/outbound и /api/documents/{id}/{approve|send|reconcile|reset-approval}, GET /api/documents/{id}. X-Flowpos-Organization выбирает разрешённую организацию; expectedVersion обязателен для переходов, tenant и principal в body запрещены. Stand отправляет фиксированному synthetic gateway; URI официального ИС ЭСФ нигде не задаётся. Ограничение 64 KiB, no CORS, exact loopback Host/Origin и header token защищают от случайного cross-origin вызова. Это не заменяет production auth.

## 15. Безопасность и эксплуатация

Production: OIDC с MFA для привилегированных операций, короткие access tokens, rotation/revocation, сервисные identities с минимальными правами. PostgreSQL runtime role без superuser/BYPASSRLS, FORCE RLS и отдельная migration role. Tenant context устанавливается SET LOCAL внутри транзакции и очищается пулом. Composite FK и ограничения обеспечивают защиту даже при ошибке прикладного фильтра. RLS тестируется фактической runtime role.

Шифрование в transit/at rest, secrets vault, envelope encryption файлов и журнал доступа. Файлы проходят лимиты размера/типов, безопасный XML parser с отключёнными external entities/DTD, антивирус, архивные лимиты/zip bomb protection; сырые ошибки не попадают в UI. SSRF egress allowlist, CSP, CSRF, session/host checks, rate limiting, dependency scanning и secret scanning. Стенд не парсит XML и не выполняет загрузку по URL.

Аудит: actor, scope, action, target/version, hash, reason, correlation_id, before/after state и timestamp без пароля/ключа/токена. Пользовательское удаление не удаляет финансовую историю; retention и legal hold по типам документов. Размещение ПД и внешняя передача LLM согласуются для РК до production, включая backup и поисковые индексы.

Метрики: last_success_sync_age, cursor_lag, unknown_count/age, quarantine_count, inbox duplicates/conflicts, queue depth, lease expiry, signing failure, reconciliation lag, ledger imbalance. Трейсы связывают UI command → job → gateway attempt, секреты редактируются. Оповещение имеет владельца, runbook и подавление повторов. Логи не подтверждают юридическое принятие документа.

## 16. Тестирование и приёмка

Слои: unit domain, component, API/schema contract, PostgreSQL integration/RLS, state machine/property tests, fault injection, UI browser E2E, migration rehearsal, backup restore, provider sandbox и hardware pilot. Нагрузочный ориентир для обсуждения: 50 организаций пилота, 100 одновременных пользователей, 100 000 документов/сутки, p95 CRUD до 500 мс без внешнего API. Это цели стендового измерения, а не подтверждённая производительность. Уполномоченные стороны уточняют реальные объёмы.

Обязательные тесты ESF: duplicate inbound; same remote key/different hash; correction chain; unknown schema; crash до cursor commit; stale approval/hash mismatch; cross tenant/org; gateway принимает запрос, ответ теряется; process crash в SENDING; restart не resend; поздний статус; истёкший сертификат/authority; частичный VAT allocation; technical ACK vs legal acceptance. В этом patch фактически покрыты local synthetic первые десять классов и signing binding; реальное certificate/portal/VAT вычисление остаются backlog.

POS gate: одна complete операция после SQLITE_BUSY/перезапуска; нет второй оплаты или фискального чека при UNKNOWN; печать/возврат/смешанная оплата/смена/киоск; старые SQLite миграции; полная рабочая смена на тестовом оборудовании. Выполненная Node fault injection не называется тестом физического отключения питания. Финансовый golden dataset принимается методологом и не меняется ради зелёного теста.

## 17. Выпуск, восстановление и миграция

Среды dev/synthetic, integration test, customer pilot и production имеют разные secrets/endpoints/data. Production enablement deny by default, отдельные feature flags по tenant/org, emergency stop и reconciliation dashboard. Миграции expand/contract, backup и restore rehearsal; irreversible transformations имеют проверенный план отката или forward fix. Никакой automatic deploy в этом пакете нет.

Проектные RPO ≤15 минут, RTO ≤4 часа для ERP, уточняются по бюджету и legal retention. PostgreSQL PITR + immutable object backups в согласованной географии; ежеквартальный restore drill проверяет БД, файлы, связи и подписи. SQLite POS сохраняет WAL и единый durable intent. Известный irreversible external effect компенсируется отдельной операцией, SQL rollback не отменяет отправленную отчётность/подпись/платёж.

Миграция клиента: inventory источников → dry run → mapping → dedup → opening balances → контроль totals/ledger → parallel read comparison → freeze window → delta import → sign-off → cutover organization → monitored pilot. Период и источник владельца каждой сущности фиксируются. Rollback не экспортирует заново уже созданные операции: IDs и mappings сохраняются.

## 18. Этапы, зависимости и критерий полноты

Этап A: baseline и отдельный безопасный ESF стенд. Этап B: tenant/auth/PostgreSQL, durable POS intent, canonical provider и accounting skeleton. Этап C: подтверждённый ESF SDK, подписант/тестовый доступ, реальный адаптер и пилот inbound/outbound. Этап D: закупки/торговля/склад/банк/бухгалтерия и миграция. Этап E: payroll/CRM/ИСНА/НКТ/статистика/ЭДО. Этап F: ограниченный MCP/autopilot и расширение pilot. Независимый стенд может идти раньше POS исправлений; production бизнес интеграция зависит от них.

Backlog содержит задачи, dependencies, приоритет, результат, критерий приёмки и ожидаемую роль. Размеры S/M/L — относительные инженерные оценки, не договорные сроки. Полный ERP принимается по матрице модулей, клиентским сценариям, сверке финансов и operational readiness. Ни один статус local done не повышает readiness полного ERP.

Production ESF gate: оригинальный SDK и checksum/WSDL/XSD; test/prod endpoint и onboarding; authority/signatory; signing profile и verification; подтверждённые send/status и server dedup; лимиты/session TTL; mapping status enums; тест на уполномоченной организации; reconciliation без дублей; runbook/monitoring/security review; методологическое подтверждение налоговых решений. Пока любой пункт не закрыт, CONTRACT_UNVERIFIED блокирует реальную подпись/отправку.


Редакция 2.1: проверенный объём второго этапа, PostgreSQL/SQLite различия, новые тесты и SDK evidence подробно зафиксированы в STAGE2.md и CHANGELOG.md, включённых в эту спецификацию. Единый backlog содержит 82 задачи; FP-081 локальный доступ/конкурентность и FP-082 PostgreSQL fixture slice не заменяют полную реализацию platform/auth/ERP.
