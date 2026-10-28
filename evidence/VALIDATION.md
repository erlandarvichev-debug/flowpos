# Фактические проверки · 27 октября 2026

Base e87ab0bd3cab1a130fdc114078d772200d3223b1, isolated branch codex/esf-local-20261027. Node 24.17.0. PostgreSQL target schema is design only; no production database or hardware was used.

| Команда / действие | Результат |
| --- | --- |
| npm ci --ignore-scripts | Успешно; из lockfile, без postinstall |
| npm test | 42 файла / 230 тестов PASS, evidence/pos-tests-final.txt |
| npm run build | PASS; предупреждение большого chunk, evidence/pos-build-final.txt |
| npm run typecheck:esf | PASS, evidence/esf-typecheck.txt |
| npm run test:esf | 13 Node tests PASS, evidence/esf-tests.txt |
| git diff --check | PASS |
| npm audit --json | 4 унаследованных advisories: 2 moderate, 2 high; без auto-fix |
| Браузер localhost | Fixture дважды → один inbound; draft→approve→UNKNOWN→reconcile→registered synthetic; reload сохранил журнал |
| Документ | 35 страниц в PDF native Word export; PNG всех страниц просмотрены в исходном размере; geometry: нет пустых страниц/выхода за границы |

Первый sandbox Vitest запуск дал ENOENT временных transformed files; повтор вне sandbox прошёл. Первый loopback Node HTTP тест был заблокирован EACCES sandbox; разрешённый повтор прошёл. Это ограничения окружения, не дефекты production кассы.

Fault injection проверяет rollback и restart SQLite файла. Физическое отключение питания, полная база, hardware/fiscal terminals, реальное ИС ЭСФ, cryptographic signing, certificate authority, PostgreSQL RLS и нагрузка не проверялись. Синтетическое согласование не является ЭЦП. Signing boundary не соединён с реальным transport.

Перенос исходных Library bytes официальным helper не завершён из-за отсутствия os.setxattr в Windows. Оригинальные IDs сохранены в SOURCES.md; новая редакция отдельна. Факт сохранения новых файлов в Library подтверждается только соответствующим результатом upload и не выводится из наличия локального DOCX/ZIP.
