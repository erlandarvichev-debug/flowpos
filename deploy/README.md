# Установка FlowPOS на сервер

Комплект готов, но **ещё не разворачивался**. Установка — по решению владельца.

Схема: один сервер Ubuntu 22.04/24.04, без Docker, systemd + nginx + PostgreSQL 16 + Redis (как на остальных проектах VPNet).

```
https://app.<домен>  → nginx → веб (статика) + /api → FlowPOS API :3000 (127.0.0.1)
https://mcp.<домен>  → nginx → MCP для клиентов :3100 (127.0.0.1) — подключение Claude
/opt/flowpos/
  releases/<дата>/   — релизы (хранятся 5 последних)
  current → releases/<активный>
  shared/api.env, mcp.env (600) · shared/data/ (состояние MCP) · shared/backups/
```

## Что нужно от владельца
1. **Сервер.** Ubuntu 22.04/24.04, 2 vCPU / 4 ГБ RAM / 40 ГБ диска для начала, root по SSH.
2. **Два имени в DNS** на IP сервера: `app.<домен>` и `mcp.<домен>` (например, `app.flowpos.kz`, `mcp.flowpos.kz`).
3. **Решение по данным.** Новый сервер стартует с пустой базой и первым администратором. Переносить ли данные из локальной базы — решить отдельно.

## Установка (первый раз)
```bash
# на своём компьютере
bash deploy/scripts/make-release.sh                       # → flowpos-release-YYYYMMDD-HHMM.tar.gz (без секретов и node_modules)
scp flowpos-release-*.tar.gz root@SERVER:/tmp/
scp -r deploy root@SERVER:/root/flowpos-deploy

# на сервере
sudo APP_DOMAIN=app.flowpos.kz MCP_DOMAIN=mcp.flowpos.kz bash /root/flowpos-deploy/scripts/install.sh
#   ставит Node 22, PostgreSQL 16, Redis, nginx, certbot; создаёт пользователя flowpos, базу,
#   секреты (JWT_SECRET, пароль БД, MCP_STATE_KEY) в /opt/flowpos/shared/*.env, службы, бэкап в cron

certbot certonly --standalone -d app.flowpos.kz -d mcp.flowpos.kz \
  --pre-hook 'systemctl stop nginx' --post-hook 'systemctl start nginx'
ln -s /etc/nginx/sites-available/flowpos.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx

sudo bash /root/flowpos-deploy/scripts/deploy.sh /tmp/flowpos-release-*.tar.gz

# первый администратор и организация (пароль печатается один раз)
cd /opt/flowpos/current && sudo -u flowpos bash -c 'set -a; . /opt/flowpos/shared/api.env; set +a; \
  node deploy/scripts/create-admin.mjs --email owner@company.kz --org "ТОО Компания" --bin 123456789012 --first Имя --last Фамилия'
```
Демо-seed (`admin@flowpos.kz / admin123`) на бою **не запускать**.

## Обновление
```bash
bash deploy/scripts/make-release.sh && scp flowpos-release-*.tar.gz root@SERVER:/tmp/
ssh root@SERVER 'bash /root/flowpos-deploy/scripts/deploy.sh /tmp/flowpos-release-….tar.gz'
```
`deploy.sh` выполняет шаги по порядку:
1. Сборка.
2. Бэкап БД.
3. Схема БД через `prisma db push` без `--accept-data-loss`. Изменение, при котором теряются данные, остановит выкладку до переключения.
4. SQL-инварианты.
5. Переключение `current`.
6. Перезапуск служб.
7. `healthcheck.sh`.

Если проверка не прошла, код откатывается на прошлый релиз. Схема БД при этом назад не откатывается, бэкап `pre-deploy` лежит в `shared/backups`.

## Службы
| Служба | Что | Порт |
|---|---|---|
| `flowpos-api` | API + автопилот бухгалтерии (15 с) + фоновая работа ИС ЭСФ (60 с) | 127.0.0.1:3000 |
| `flowpos-mcp` | MCP для клиентов (OAuth) | 127.0.0.1:3100 |
| `flowpos-worker@moysklad-worker` и др. | обмен с МойСклад/1С, push, аналитика — **включать только используемые** | — |

Журналы: `journalctl -u flowpos-api -f`. Проверка: `bash deploy/scripts/healthcheck.sh`.

## Бэкап и восстановление
- Ежедневно в 03:30: `pg_dump -Fc` + состояние MCP, хранятся 14 дней. Перед каждой выкладкой делается отдельный бэкап, он хранится 30 дней. Каждый дамп сразу проверяется `pg_restore --list`.
- Восстановление: `systemctl stop flowpos-api flowpos-mcp && pg_restore --clean --if-exists --no-owner -d flowpos <файл.dump> && systemctl start flowpos-api flowpos-mcp`.
- Проверено 23.10.2026 на тестовой базе: дамп восстанавливается в пустую БД, число проводок, ЭСФ и организаций совпадает, триггеры неизменяемости на месте.
- **Рекомендация:** копировать `shared/backups` на второй сервер или в облако, иначе при потере диска пропадут и бэкапы.

## Безопасность (что сделано)
- API в боевом режиме **не запускается** без `JWT_SECRET` и `ESF_SIGNING_SECRET` (оба ≥ 32 символов), `DATABASE_URL` и `CORS_ORIGIN`. На уже установленном сервере `ESF_SIGNING_SECRET` нужно **дописать вручную** в `/opt/flowpos/shared/api.env` до обновления (`openssl rand -hex 32`). Раньше был запасной общеизвестный ключ `flowpos-secret`, и токены можно было подделать.
- Swagger в бою выключен (`SWAGGER_ENABLED=1` — включить временно).
- API и MCP слушают только 127.0.0.1, снаружи доступ только через nginx с TLS.
- nginx ограничивает частоту входа (10/мин с IP) и запросов к API, ставит HSTS и запрет встраивания в чужие сайты.
- Службы работают от пользователя `flowpos` с изоляцией systemd. Файлы с секретами — права 600.
- В архив релиза не попадают `.env`, ключи и состояние MCP: это проверяется при сборке.

## Проверено перед передачей
- Сборка из архива на чистом каталоге: `npm ci`, prisma generate, api, web, mcp.
- Боевой запуск API: без секрета отказ, с секретом Swagger отдаёт 404, вход работает, порт слушается только на 127.0.0.1.
- `healthcheck.sh` против запущенных сервисов. Бэкап и восстановление.
- `create-admin.mjs` на тестовой базе: создание, повтор без изменений, ошибка при нехватке параметров.
- **Не проверено:** `install.sh` и `deploy.sh` целиком на Ubuntu. Их запуск — первая установка.

## Исправлено по ходу подготовки
- `apps/api`: сборка клала `main.js` в `dist/src/`, а `npm start` искал `dist/main.js`. Добавлен `tsconfig.build.json`.
- `sync-worker`, `moysklad-worker`, `push-worker`: `npm start` указывал на несуществующий файл.
