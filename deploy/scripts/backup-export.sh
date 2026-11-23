#!/usr/bin/env bash
# Выгрузка копий баз на компьютер владельца (копия вне сервера).
# Ставится в /usr/local/bin/flowpos-backup-export и вызывается ТОЛЬКО через отдельный ключ
# в /root/.ssh/authorized_keys с command="/usr/local/bin/flowpos-backup-export",restrict —
# этим ключом нельзя ни войти в консоль, ни выполнить другую команду.
# Аргумент (SSH_ORIGINAL_COMMAND): за сколько дней отдать файлы, 1–60 (по умолчанию 3).
# На выходе tar: flowpos/*.dump (база FlowPOS) и vpnet/*.sql.gz (база vpnet_ai).
set -euo pipefail
cd /
DAYS="${SSH_ORIGINAL_COMMAND:-3}"
[[ "$DAYS" =~ ^[0-9]{1,2}$ ]] && [ "$DAYS" -ge 1 ] && [ "$DAYS" -le 60 ] || { echo "дни: 1-60" >&2; exit 2; }
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
find /opt/flowpos/shared/backups -maxdepth 1 -type f -name 'flowpos-*.dump' -mtime -"$DAYS" -printf 'opt/flowpos/shared/backups/%f\n' >> "$TMP"
[ -d /var/backups/vpnet ] && find /var/backups/vpnet -maxdepth 1 -type f -name 'vpnet_ai-*.sql.gz' -mtime -"$DAYS" -printf 'var/backups/vpnet/%f\n' >> "$TMP"
tar -C / -cf - --transform 's,^opt/flowpos/shared/backups/,flowpos/,;s,^var/backups/vpnet/,vpnet/,' -T "$TMP"
