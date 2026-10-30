#!/usr/bin/env bash
# Первичная подготовка сервера FlowPOS (Ubuntu 22.04/24.04). Запускать от root ОДИН раз.
#   sudo APP_DOMAIN=app.example.kz MCP_DOMAIN=mcp.example.kz bash install.sh
# Ставит Node.js 22, PostgreSQL 16, Redis, nginx, certbot; создаёт пользователя flowpos, каталоги,
# базу и секреты. Ничего не перезаписывает: если файлы настроек уже есть — оставляет их.
set -euo pipefail

: "${APP_DOMAIN:?Укажите APP_DOMAIN, напр. app.example.kz}"
: "${MCP_DOMAIN:?Укажите MCP_DOMAIN, напр. mcp.example.kz}"
ROOT=/opt/flowpos
SHARED=$ROOT/shared
HERE="$(cd "$(dirname "$0")/.." && pwd)"   # каталог deploy/

[ "$(id -u)" = 0 ] || { echo "Нужен root (sudo)"; exit 1; }
. /etc/os-release
echo "== Система: $PRETTY_NAME"

echo "== Пакеты"
apt-get update -y
apt-get install -y ca-certificates curl gnupg nginx redis-server certbot python3-certbot-nginx rsync
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v psql >/dev/null; then
  if apt-cache show postgresql-16 >/dev/null 2>&1; then apt-get install -y postgresql-16; else
    install -d /usr/share/postgresql-common/pgdg
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
    apt-get update -y && apt-get install -y postgresql-16
  fi
fi
systemctl enable --now postgresql redis-server nginx
echo "   node $(node -v), $(psql --version)"

echo "== Пользователь и каталоги"
id flowpos >/dev/null 2>&1 || useradd --system --home $ROOT --shell /usr/sbin/nologin flowpos
install -d -o flowpos -g flowpos -m 750 $ROOT $ROOT/releases $SHARED $SHARED/data $SHARED/backups
install -d -m 755 /var/www/certbot

echo "== База данных"
if [ ! -f $SHARED/api.env ]; then
  DB_PASS="$(openssl rand -hex 24)"
  APP_DB_PASS="$(openssl rand -hex 24)"
  # FP-009: flowpos — владелец таблиц и роль миграций (BYPASSRLS: FORCE RLS действует и на владельца);
  # flowpos_app — рабочая роль API и воркеров: без SUPERUSER и BYPASSRLS, только DML (права выдаёт sql/040).
  if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='flowpos'" | grep -q 1; then
    sudo -u postgres psql -c "alter role flowpos with password '$DB_PASS' bypassrls"
  else
    sudo -u postgres psql -c "create role flowpos login password '$DB_PASS' bypassrls"
  fi
  if sudo -u postgres psql -tAc "select 1 from pg_roles where rolname='flowpos_app'" | grep -q 1; then
    sudo -u postgres psql -c "alter role flowpos_app with login password '$APP_DB_PASS' nosuperuser nobypassrls nocreatedb nocreaterole"
  else
    sudo -u postgres psql -c "create role flowpos_app login password '$APP_DB_PASS' nosuperuser nobypassrls nocreatedb nocreaterole"
  fi
  sudo -u postgres psql -tAc "select 1 from pg_database where datname='flowpos'" | grep -q 1 || sudo -u postgres createdb -O flowpos flowpos

  echo "== Настройки API (секреты сгенерированы)"
  sed -e "s#postgresql://flowpos:<пароль-БД>@#postgresql://flowpos:${DB_PASS}@#" \
      -e "s#postgresql://flowpos_app:<пароль-рабочей-роли>@#postgresql://flowpos_app:${APP_DB_PASS}@#" \
      -e "s#JWT_SECRET=<сгенерировать>#JWT_SECRET=$(openssl rand -hex 32)#" \
      -e "s#ESF_SIGNING_SECRET=<сгенерировать>#ESF_SIGNING_SECRET=$(openssl rand -hex 32)#" \
      -e "s#MFA_SECRET_KEY=<сгенерировать>#MFA_SECRET_KEY=$(openssl rand -hex 32)#" \
      -e "s#https://app.example.kz#https://${APP_DOMAIN}#" \
      "$HERE/env/api.env.example" > $SHARED/api.env
else
  echo "   $SHARED/api.env уже есть — не трогаю"
fi
if [ ! -f $SHARED/mcp.env ]; then
  sed -e "s#MCP_STATE_KEY=<сгенерировать>#MCP_STATE_KEY=$(openssl rand -hex 32)#" \
      -e "s#https://mcp.example.kz#https://${MCP_DOMAIN}#" \
      -e "s#https://app.example.kz#https://${APP_DOMAIN}#" \
      "$HERE/env/mcp.env.example" > $SHARED/mcp.env
else
  echo "   $SHARED/mcp.env уже есть — не трогаю"
fi
chown flowpos:flowpos $SHARED/*.env && chmod 600 $SHARED/*.env

echo "== systemd"
install -m 644 "$HERE/systemd/flowpos-api.service" "$HERE/systemd/flowpos-mcp.service" "$HERE/systemd/flowpos-worker@.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable flowpos-api flowpos-mcp

echo "== nginx"
install -m 644 "$HERE/nginx/flowpos-proxy.conf" /etc/nginx/snippets/flowpos-proxy.conf
sed -e "s/app.example.kz/${APP_DOMAIN}/g" -e "s/mcp.example.kz/${MCP_DOMAIN}/g" "$HERE/nginx/flowpos.conf" > /etc/nginx/sites-available/flowpos.conf
echo "   Конфиг: /etc/nginx/sites-available/flowpos.conf (ещё НЕ включён — сначала сертификаты)"

echo "== Бэкап по расписанию (ежедневно 03:30)"
install -m 755 "$HERE/scripts/backup.sh" /usr/local/bin/flowpos-backup
echo "30 3 * * * flowpos /usr/local/bin/flowpos-backup >> $SHARED/backups/backup.log 2>&1" > /etc/cron.d/flowpos-backup

cat <<EOT

Готово. Дальше:
 1. DNS: ${APP_DOMAIN} и ${MCP_DOMAIN} → IP этого сервера.
 2. Сертификат (один на оба имени; nginx на минуту останавливается, продление — так же автоматически):
    certbot certonly --standalone -d ${APP_DOMAIN} -d ${MCP_DOMAIN} \\
      --pre-hook 'systemctl stop nginx' --post-hook 'systemctl start nginx'
 3. Включить сайт: ln -s /etc/nginx/sites-available/flowpos.conf /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
 4. Выложить код: deploy.sh (см. deploy/README.md), затем создать администратора: create-admin.mjs
EOT
