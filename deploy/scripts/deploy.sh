#!/usr/bin/env bash
# Выкладка релиза FlowPOS на сервер с откатом. Запускать от root на сервере:
#   sudo bash deploy.sh /tmp/flowpos-release-YYYYMMDD-HHMM.tar.gz
# Порядок: распаковка → npm ci → сборка → бэкап БД → схема БД (без потери данных) → переключение →
# перезапуск → проверка здоровья. Если проверка не прошла — возврат на предыдущий релиз.
set -euo pipefail

ARCHIVE="${1:?Укажите архив релиза (make-release.sh)}"
ROOT=/opt/flowpos
SHARED=$ROOT/shared
REL=$ROOT/releases/$(date +%Y%m%d-%H%M%S)
PREV="$(readlink -f $ROOT/current 2>/dev/null || true)"
KEEP=5
as_app() { sudo -u flowpos -H bash -c "cd '$REL' && set -a && . $SHARED/api.env && set +a && $*"; }

[ "$(id -u)" = 0 ] || { echo "Нужен root (sudo)"; exit 1; }
[ -f $SHARED/api.env ] || { echo "Нет $SHARED/api.env — сначала install.sh"; exit 1; }

echo "== Распаковка в $REL"
install -d -o flowpos -g flowpos "$REL"
tar -xzf "$ARCHIVE" -C "$REL"
chown -R flowpos:flowpos "$REL"

echo "== Зависимости и сборка"
as_app "npm ci --no-audit --no-fund"
as_app "npm run generate --workspace=packages/db"
for w in api web mcp; do as_app "npm run build --workspace=apps/$w"; done
for w in sync-worker moysklad-worker push-worker analytics-worker; do
  systemctl is-enabled --quiet "flowpos-worker@$w" 2>/dev/null && as_app "npm run build --workspace=apps/$w"
done

echo "== Бэкап БД перед изменением схемы"
sudo -u flowpos /usr/local/bin/flowpos-backup pre-deploy

echo "== Схема БД: подготовка данных (sql/pre), prisma db push без --accept-data-loss (опасные изменения остановят выкладку), SQL-инварианты"
as_app "cd packages/db && node scripts/apply-sql.js --pre && npx prisma db push --skip-generate && node scripts/apply-sql.js"

echo "== Переключение"
ln -sfn "$REL" $ROOT/current
systemctl restart flowpos-api flowpos-mcp
for u in $(systemctl list-units --plain --no-legend 'flowpos-worker@*' | awk '{print $1}'); do systemctl restart "$u"; done

if bash "$(dirname "$0")/healthcheck.sh"; then
  echo "== Релиз $(basename "$REL") работает"
  ls -1dt $ROOT/releases/* | tail -n +$((KEEP + 1)) | xargs -r rm -rf
else
  echo "!! Проверка не прошла — откат на $(basename "${PREV:-нет}")"
  if [ -n "$PREV" ]; then
    ln -sfn "$PREV" $ROOT/current
    systemctl restart flowpos-api flowpos-mcp
    echo "   Код откатан. Схема БД изменений назад не делает; бэкап до выкладки: $SHARED/backups (pre-deploy)."
  fi
  journalctl -u flowpos-api -n 40 --no-pager || true
  exit 1
fi
