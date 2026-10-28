#!/usr/bin/env bash
# Проверка, что FlowPOS отвечает после запуска (ждёт до 60 с). Код выхода 0 — всё в порядке.
set -uo pipefail
ok() { printf '   %-26s %s\n' "$1" "$2"; }
wait_code() { # url ожидаемые_коды
  for _ in $(seq 1 30); do
    c=$(curl -s -o /dev/null -w '%{http_code}' "$1" || true)
    [[ " $2 " == *" $c "* ]] && { echo "$c"; return 0; }
    sleep 2
  done
  echo "${c:-000}"; return 1
}
fail=0
c=$(wait_code http://127.0.0.1:3000/api/v1/auth/me "401") && ok "API" "отвечает ($c)" || { ok "API" "НЕТ ОТВЕТА ($c)"; fail=1; }
c=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/docs || true); [ "$c" = 404 ] && ok "Swagger закрыт" "да" || ok "Swagger закрыт" "НЕТ ($c) — проверьте SWAGGER_ENABLED"
c=$(wait_code http://127.0.0.1:3100/health "200") && ok "MCP" "отвечает" || { ok "MCP" "НЕТ ОТВЕТА ($c)"; fail=1; }
c=$(wait_code http://127.0.0.1:3100/.well-known/oauth-authorization-server "200") && ok "MCP OAuth" "метаданные есть" || { ok "MCP OAuth" "НЕТ ($c)"; fail=1; }
[ -f "${WEB_DIST:-/opt/flowpos/current/apps/web/dist}/index.html" ] && ok "Веб" "собран" || { ok "Веб" "НЕТ index.html"; fail=1; }
exit $fail
