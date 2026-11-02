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
tar $XATTR -czf "$OUT" \
  --exclude='./.git' --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='*/dist' --exclude='*/coverage' --exclude='*.tsbuildinfo' \
  --exclude='.env' --exclude='*/.env' --exclude='*/.env.*' \
  --exclude='./flowpos-release-*.tar.gz' --exclude='*/data/mcp-oauth.json' \
  --exclude='*/.vite' --exclude='.DS_Store' \
  .
# Контроль: в архиве не должно быть .env и ключей
if tar -tzf "$OUT" | grep -E '(^|/)\.env$|\.p12$|mcp-oauth\.json$' ; then
  echo "!! В архив попали секреты — архив удалён"; rm -f "$OUT"; exit 1
fi
echo "Готово: $OUT ($(du -h "$OUT" | cut -f1)), файлов: $(tar -tzf "$OUT" | wc -l | tr -d ' ')"
