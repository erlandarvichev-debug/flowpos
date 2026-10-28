from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];docs=ROOT/'docs/erp'
p=docs/'TECHNICAL_SPECIFICATION.md';s=p.read_text(encoding='utf-8');s=s.replace('Техническая спецификация 2.0','Техническая спецификация 2.1')
s=s.replace('Реализовано локально: отдельный Node/TypeScript модуль, синтетический gateway, SQLite WAL, черновик, согласование hash/TTL, одна попытка отправки, UNKNOWN, сверка, приём fixture, карантин неизвестной схемы, атомарный cursor, журнал и loopback UI.',
 'Реализовано локально: отдельный Node/TypeScript модуль, синтетический gateway, SQLite WAL/FULL со schema v2, version/approval/hash/TTL, составные FK, lease/fencing, одна попытка отправки, UNKNOWN и сверка. AuthProvider отделён от серверной проверки grants организации/действия. UI поддерживает read-only организацию, карантин с исходными полями и стабильный повтор создания. PostgreSQL ESF SQL-миграция проверяется отдельно на реальном временном PostgreSQL 16.9; HTTP repository пока SQLite.')
s=s.replace('Спроектировано, ещё не реализовано: PostgreSQL ERP, многопользовательская авторизация,','Спроектировано, ещё не реализовано: полный PostgreSQL ERP и его HTTP repository adapter, производственная многопользовательская аутентификация,')
s=s.replace('Его server-side scope фиксирован, 200 строк без production пагинации; это прототип, не готовый многопользовательский frontend.', 'Его principal фиксирован provider на сервере; организация и действие ограничены grants, 200 строк без production пагинации. Это прототип без production identity provider.')
s=s.replace('POST /api/fixtures/inbound, /api/outbound и /api/documents/{id}/{approve|send|reconcile}.','POST /api/fixtures/inbound, /api/outbound и /api/documents/{id}/{approve|send|reconcile|reset-approval}, GET /api/documents/{id}. X-Flowpos-Organization выбирает разрешённую организацию; expectedVersion обязателен для переходов, tenant и principal в body запрещены.')
s=s.replace('Основной срез','Основной срез')
s+='\n\nРедакция 2.1: проверенный объём второго этапа, PostgreSQL/SQLite различия, новые тесты и SDK evidence подробно зафиксированы в STAGE2.md и CHANGELOG.md, включённых в эту спецификацию. Единый backlog содержит 82 задачи; FP-081 локальный доступ/конкурентность и FP-082 PostgreSQL fixture slice не заменяют полную реализацию platform/auth/ERP.\n'
p.write_text(s,encoding='utf-8')
p=docs/'HANDOFF.md';p.write_text('''# Handoff · редакция 2.1

Весь исходный ERP scope сохранён; backlog 82 задачи. Этап 1: baseline и synthetic ESF. Этап 2: серверные grants, version/approval checks, SQLite migration v2, multi-process leases/fencing, UI карантина/read-only и отдельный PostgreSQL SQL slice.

HTTP runtime: Node 24.17 + SQLite; несколько процессов на одном локальном файле проверены, active leases сохраняются, expired→UNKNOWN без resend. Нет production scheduler/HA и отдельного PostgreSQL repository adapter. AuthProvider использует локальные fixtures, не OIDC и не credentials. Signing mock не является ЭЦП. Прямой ИС ЭСФ transport заблокирован CONTRACT_UNVERIFIED.

PostgreSQL: erp/postgres/001_esf.sql + 002_runtime_grants.sql; реальные RLS/command/concurrency/restart fixture tests отдельно от HTTP. Общий docs/erp/contracts/target-model.sql остаётся design-only для всего ERP и не является полной миграцией.

Читать STAGE2.md, CHANGELOG.md, ACCEPTANCE.md и evidence/STAGE2_VALIDATION.md. Не изменять работающую POS и чужие правки. FP-002 Rust atomic intent остаётся открытым. Разрешение на production/подпись/реальную отправку отсутствует.

Обновляются прежние Library IDs DOCX libfile_4ceaf36ad160819195399e4ff06005cb и ZIP libfile_6623e34eae3881918d9ea21215ed2ea1 с expected version 0. Исходные входные документы отдельно сохранены как lineage в SOURCES.md.
''',encoding='utf-8')
p=docs/'LOCAL_RUNBOOK.md';s=p.read_text(encoding='utf-8');s+='''

## Этап 2: scope и SQL-проверки

Browser показывает fixture principal и организации. stand-org разрешает действия, stand-org-b — только чтение; кнопки не заменяют серверную проверку. API требует X-Flowpos-Organization для scoped routes и expectedVersion для переходов. POST body не содержит tenant/principal. Signing, транспорт и данные остаются синтетическими.

При UNKNOWN не отправлять повторно. Expired approval возвращается в DRAFT явной командой reset-approval. Неподдерживаемая форма остаётся в карантине; Детали показывают schema/hash/исходную строку. Pending draft сохраняет operation ID в sessionStorage до известного ответа; кнопка восстановления не отправляет его автоматически.

PostgreSQL harness требует отдельного disposable cluster и fixture superuser esf_fixture_admin без пароля, только loopback. Не использовать рабочую БД. Пример после initdb/pg_ctl локального test cluster:
python tools/test_esf_postgres.py --psql <absolute-psql> --port <fixture-port> --pg-ctl <absolute-pg_ctl> --cluster <absolute-disposable-cluster>
Harness проверяет data_directory и пользователя, создаёт собственную fixture DB и NOLOGIN роли, применяет SQL, проверяет конкурентность/RLS/restart и удаляет test DB при успехе. После теста остановить только этот cluster. SQL scripts приложения не создают login role, пароль или постоянный внешний доступ.
''';p.write_text(s,encoding='utf-8')
p=ROOT/'erp/esf-stand/README.md';s=p.read_text(encoding='utf-8');s=s.replace('Scope is fixed server-side to stand tenant/org.', 'Principal comes from a fixed server-side fixture AuthProvider. Select stand-org (operator) or stand-org-b (read-only); organization header is only a selector checked against server grants. Client tenant/principal fields are rejected.')
s=s.replace('Limitations: one local process, no multi-worker lease,','Limits: local SQLite lease/fencing is tested across processes, but no distributed production worker scheduler/HA,')
s+='\nStage 2: schema v2 upgrades old local synthetic DB atomically. Active SENDING is retained across second-process startup; only expired leases recover UNKNOWN. Fenced callbacks cannot overwrite reconciliation. Version is required on API transitions. PostgreSQL SQL migrations/tests are in erp/postgres and tools/test_esf_postgres.py, separately from the SQLite HTTP runtime. See docs/erp/STAGE2.md.\n';p.write_text(s,encoding='utf-8')
p=ROOT/'tools/build_spec.py';s=p.read_text(encoding='utf-8').replace('Редакция 2.0','Редакция 2.1').replace('Техническая спецификация 2.0','Техническая спецификация 2.1').replace('80 задач','82 задачи')
s=s.replace("    footer=s.footer.paragraphs[0];footer.alignment=2", "    for title,path in [('Приложение E. Второй инженерный этап','STAGE2.md'),('История изменений','CHANGELOG.md')]:\n        doc.add_page_break();doc.add_heading(title,level=1);add_markdown(doc,SOURCE/path)\n    footer=s.footer.paragraphs[0];footer.alignment=2")
p.write_text(s,encoding='utf-8')
print('Updated v2.1 sources and builder')
