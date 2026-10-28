# Разработчику: локальный запуск и продолжение

Baseline SHA и ownership см. REPOSITORY_BASELINE.md. Используйте отдельный checkout авторизованного репозитория. Не копируйте .env, ключи, живые SQLite, пользовательский AppData или node_modules кассы.

Требуется Node 24.17+; встроенный node:sqlite пока experimental. После `npm ci --ignore-scripts`:

```
npm test
npm run build
npm run typecheck:esf
npm run test:esf
npm run dev:esf
```

Открыть http://127.0.0.1:14840. Сценарий: дважды Получить тестовый входящий → один документ; создать исходящий → тестово согласовать → отправить на стенде → UNKNOWN → сверить → REGISTERED на стенде. Никакой endpoint портала, certificate или key не вводится. Завершить Ctrl+C; сохранённые synthetic данные остаются в игнорируемой `.local-stand`. Не публиковать сервер через reverse proxy.

Режим кроме synthetic отклоняется. Реальный transport отсутствует физически; добавление строки URL не превращает mock в production. SigningProvider пока отдельная проверяемая граница, не часть криптографической подписи HTTP отправки.

Тесты: `*.node-test.ts` запускает Node; именование исключает случайный сбор этих файлов Vitest. Root POS tests остаются на Vitest. При Windows sandbox ENOENT transformed temp files используйте разрешённый запуск тестов в нормальном temp, не меняйте production код ради этой ошибки окружения.

Продолжение: FP-010…FP-024 для ESF, FP-002…FP-006 для POS reliability; platform/auth до любой сетевой публикации. Внешний SDK сначала проверить как bytes/checksum/XSD/WSDL, бинарники из архива не запускать. Реальные методы и enums добавлять только после контрактного теста. Не переносить placeholder SQL напрямую на production.

Локальная сборка документа: Python + python-docx; `python tools/build_spec.py`. В этой среде стандартный bundled renderer не разрешился; visual QA выполнен native Word export + PyMuPDF PNG. Локальные Linux xattrs Library helper на Windows недоступны; это отдельный delivery blocker, не повод изменять helper или оригинальный ID.


## Этап 2: scope и SQL-проверки

Browser показывает fixture principal и организации. stand-org разрешает действия, stand-org-b — только чтение; кнопки не заменяют серверную проверку. API требует X-Flowpos-Organization для scoped routes и expectedVersion для переходов. POST body не содержит tenant/principal. Signing, транспорт и данные остаются синтетическими.

При UNKNOWN не отправлять повторно. Expired approval возвращается в DRAFT явной командой reset-approval. Неподдерживаемая форма остаётся в карантине; Детали показывают schema/hash/исходную строку. Pending draft сохраняет operation ID в sessionStorage до известного ответа; кнопка восстановления не отправляет его автоматически.

PostgreSQL harness требует отдельного disposable cluster и fixture superuser esf_fixture_admin без пароля, только loopback. Не использовать рабочую БД. Пример после initdb/pg_ctl локального test cluster:
python tools/test_esf_postgres.py --psql <absolute-psql> --port <fixture-port> --pg-ctl <absolute-pg_ctl> --cluster <absolute-disposable-cluster>
Harness проверяет data_directory и пользователя, создаёт собственную fixture DB и NOLOGIN роли, применяет SQL, проверяет конкурентность/RLS/restart и удаляет test DB при успехе. После теста остановить только этот cluster. SQL scripts приложения не создают login role, пароль или постоянный внешний доступ.
