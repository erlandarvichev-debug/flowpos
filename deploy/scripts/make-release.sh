#!/usr/bin/env bash
# Сборка архива релиза на машине разработчика (исходники без node_modules, сборок и секретов).
#   bash deploy/scripts/make-release.sh   → ./flowpos-release-YYYYMMDD-HHMM.tar.gz
# Затем: scp архив deploy/ на сервер → sudo bash deploy/scripts/deploy.sh /tmp/<архив>
set -euo pipefail
cd "$(dirname "$0")/../.."
OUT="flowpos-release-$(date +%Y%m%d-%H%M).tar.gz"
# macOS: без расширенных атрибутов и ._-файлов (иначе на сервере tar предупреждает о LIBARCHIVE.xattr).
export COPYFILE_DISABLE=1
XATTR=$(tar --version 2>/dev/null | grep -q bsdtar && echo --no-xattrs || true)
# Архив пишется во временную папку: если писать его в упаковываемый каталог, tar видит, что «.» меняется,
# и падает («file changed as we read it») — а с ним пропускалась бы и проверка на секреты ниже.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
tar $XATTR -czf "$TMP/$OUT" \
  --exclude='./.git' --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='*/dist' --exclude='*/coverage' --exclude='*.tsbuildinfo' \
  --exclude='.env' --exclude='*/.env' --exclude='*/.env.*' \
  --exclude='./flowpos-release-*.tar.gz' --exclude='*/data/mcp-oauth.json' \
  --exclude='*/.vite' --exclude='.DS_Store'   --exclude='./.pgtest' --exclude='./_baseline' --exclude='./.claude' --exclude='*/data/field' \
  .
mv "$TMP/$OUT" "$OUT"
# Контроль: в архиве не должно быть .env и ключей
if tar -tzf "$OUT" | grep -E '(^|/)\.env$|\.p12$|mcp-oauth\.json$|(^|/)\.pgtest/|test-login\.txt$' ; then
  echo "!! В архив попали секреты — архив удалён"; rm -f "$OUT"; exit 1
fi
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1)), файлов: $(tar -tzf "$OUT" | wc -l | tr -d ' ')"
