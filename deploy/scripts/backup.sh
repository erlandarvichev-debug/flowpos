#!/usr/bin/env bash
# Бэкап FlowPOS: база (pg_dump -Fc) и состояние MCP. Хранение 14 дней (pre-deploy — 30).
#   flowpos-backup [метка]       — ставится в /usr/local/bin install.sh'ем, запускается cron'ом от flowpos
# Восстановление: pg_restore --clean --if-exists -d flowpos <файл.dump> (остановив flowpos-api).
set -euo pipefail
SHARED=${FLOWPOS_SHARED:-/opt/flowpos/shared}
DIR=$SHARED/backups
TAG="${1:-daily}"
TS=$(date +%Y%m%d-%H%M%S)
set -a; . $SHARED/api.env; set +a
DB_URL="${DATABASE_URL%%\?*}"

mkdir -p "$DIR"
pg_dump -Fc --no-owner -d "$DB_URL" -f "$DIR/flowpos-$TAG-$TS.dump"
[ -f $SHARED/data/mcp-oauth.json ] && cp -p $SHARED/data/mcp-oauth.json "$DIR/mcp-oauth-$TAG-$TS.json"
# проверка, что дамп читается
pg_restore --list "$DIR/flowpos-$TAG-$TS.dump" >/dev/null
find "$DIR" -name 'flowpos-daily-*' -mtime +14 -delete
find "$DIR" -name 'mcp-oauth-daily-*' -mtime +14 -delete
find "$DIR" -name '*pre-deploy*' -mtime +30 -delete
echo "$(date '+%F %T') ok $DIR/flowpos-$TAG-$TS.dump ($(du -h "$DIR/flowpos-$TAG-$TS.dump" | cut -f1))"
