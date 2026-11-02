#!/usr/bin/env bash
# Публикация стенда/сервера по домену с HTTPS: bash public-domain.sh flowpos.kz [192.168.2.0/24]
# Идемпотентно. Порядок: nginx на 80 (проверка Let's Encrypt + перенаправление на HTTPS), брандмауэр 80/443 для всех,
# сертификат Let's Encrypt (без email; продление — таймер certbot с перезагрузкой nginx), HTTPS-сайт, fail2ban на
# перебор и сканеры. Доступ по IP (без домена) остаётся только из локальной сети. SSH — только из локальной сети.
# Если сертификат получить не удалось (порты 80/443 на роутере ещё не проброшены) — сайт по домену остаётся на HTTP
# только для проверки Let's Encrypt; запустите скрипт ещё раз после проброса.
set -euo pipefail
DOMAIN="${1:?домен, например flowpos.kz}"
NET="${2:-192.168.2.0/24}"
E=/opt/flowpos/shared/api.env
WEBROOT=/var/www/certbot
LIVE=/etc/letsencrypt/live/$DOMAIN

echo "== nginx: доступ по IP — только из локальной сети ($NET)"
LAN=/etc/nginx/sites-available/flowpos-lan.conf
if [ -f "$LAN" ] && ! grep -q "allow $NET" "$LAN"; then
  sed -i "s#    server_name _;#    server_name _;\n    allow $NET;\n    allow 127.0.0.1;\n    deny all;#" "$LAN"
fi

echo "== nginx: $DOMAIN на 80 — проверка Let's Encrypt и перенаправление на HTTPS"
mkdir -p "$WEBROOT"
PUB=/etc/nginx/sites-available/flowpos-public.conf
cat > "$PUB" <<NG
# FlowPOS: публичный адрес $DOMAIN (сгенерировано deploy/scripts/public-domain.sh)
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root $WEBROOT; }
    location / { return 301 https://\$host\$request_uri; }
}
NG
if [ -f "$LIVE/fullchain.pem" ]; then
  cat >> "$PUB" <<NG

server {
    listen 443 ssl http2;
    server_name $DOMAIN;
    ssl_certificate     $LIVE/fullchain.pem;
    ssl_certificate_key $LIVE/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header Referrer-Policy strict-origin-when-cross-origin always;
    client_max_body_size 25m;
    root /opt/flowpos/current/apps/web/dist;
    index index.html;
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files \$uri =404; }
    location = /api/v1/auth/login { limit_req zone=flowpos_login burst=5 nodelay; proxy_pass http://127.0.0.1:3000; include /etc/nginx/snippets/flowpos-proxy.conf; }
    location = /api/v1/ops/metrics { return 404; }
    location /api/docs { return 404; }
    location /api/ { limit_req zone=flowpos_api burst=60 nodelay; proxy_pass http://127.0.0.1:3000; include /etc/nginx/snippets/flowpos-proxy.conf; proxy_read_timeout 120s; }
    location / { try_files \$uri /index.html; add_header Cache-Control "no-cache"; }
}
NG
fi
# Чужие имена хостов (сканеры по IP с интернета) — закрыть соединение без ответа.
cat > /etc/nginx/sites-available/flowpos-catchall-443.conf <<'NG'
server { listen 443 ssl default_server; ssl_reject_handshake on; }
NG
ln -sfn "$PUB" /etc/nginx/sites-enabled/flowpos-public.conf
ln -sfn /etc/nginx/sites-available/flowpos-catchall-443.conf /etc/nginx/sites-enabled/flowpos-catchall-443.conf
nginx -t && systemctl reload nginx

echo "== брандмауэр: 80/443 — для всех (сайт и Let's Encrypt), SSH — только $NET"
ufw allow 80/tcp comment 'FlowPOS HTTP (Let’s Encrypt, перенаправление на HTTPS)' >/dev/null
ufw allow 443/tcp comment 'FlowPOS HTTPS' >/dev/null
ufw status | grep -E '^(22|80|443)' || true

echo "== fail2ban: перебор входа (limit_req) и сканеры"
cat > /etc/fail2ban/jail.d/flowpos-nginx.local <<'J'
[nginx-limit-req]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 10
findtime = 10m
bantime  = 1h

[nginx-botsearch]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/access.log
maxretry = 5
bantime  = 6h
J
systemctl restart fail2ban
sleep 2
fail2ban-client status | sed -n '2,3p'

if [ ! -f "$LIVE/fullchain.pem" ]; then
  echo "== Let's Encrypt: сертификат для $DOMAIN"
  if certbot certonly --webroot -w "$WEBROOT" -d "$DOMAIN" --agree-tos --register-unsafely-without-email --non-interactive \
       --deploy-hook 'systemctl reload nginx'; then
    echo "   сертификат получен — включаю HTTPS"
    exec bash "$0" "$DOMAIN" "$NET"
  else
    echo "   НЕ получен: Let's Encrypt не достучался до http://$DOMAIN/.well-known/ — проверьте проброс портов 80/443 на роутере и повторите."
    exit 2
  fi
fi

echo "== API: адрес веб-интерфейса https://$DOMAIN"
sed -i "s#^CORS_ORIGIN=.*#CORS_ORIGIN=https://$DOMAIN#" "$E"
systemctl restart flowpos-api
sleep 4
curl -s -o /dev/null -w "   https://$DOMAIN/api/v1/auth/me → %{http_code} (401 — норма без входа)\n" --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/v1/auth/me" || true
echo "Готово: https://$DOMAIN"
