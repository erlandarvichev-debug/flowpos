#!/usr/bin/env bash
# Тестовый стенд FlowPOS в локальной сети: штатный install.sh + HTTP по адресу сервера вместо TLS и доменов.
# НЕ прод: фоновая обработка ЭСФ выключена (на стенд КГД ничего не уходит), второй фактор не обязателен, HTTP без TLS.
# Запуск (root, из скопированного каталога deploy):  sudo bash /home/web/flowpos-deploy/scripts/lan-stand.sh
# Дальше — как в README: deploy.sh с архивом релиза и create-admin.mjs. Доступ: http://<адрес> или http://<hostname>.local
# (mDNS ставится здесь же). Firewall: SSH, веб и mDNS — только из локальной сети этого сервера.
set -euo pipefail
# Адрес сервера в локальной сети (DHCP может его сменить — тогда рекомендуется закрепить адрес на роутере).
IP=$(hostname -I | awk '{print $1}')
echo "== Адрес стенда: $IP"
# У сервера нет маршрута IPv6, а зеркала отдают IPv6-адреса — apt только по IPv4, иначе загрузки зависают.
echo 'Acquire::ForceIPv4 "true";' > /etc/apt/apt.conf.d/99force-ipv4
dpkg --configure -a || true
cd "$(dirname "$0")/.."
APP_DOMAIN=$IP MCP_DOMAIN=mcp.lan.invalid bash scripts/install.sh

E=/opt/flowpos/shared/api.env
sed -i "s#^CORS_ORIGIN=.*#CORS_ORIGIN=http://$IP#" $E
grep -q '^ESF_WORKER_DISABLED=' $E || echo 'ESF_WORKER_DISABLED=1' >> $E
grep -q '^MFA_ENFORCE=' $E || echo 'MFA_ENFORCE=0' >> $E

cat > /etc/nginx/sites-available/flowpos-lan.conf <<NG
# Тестовый стенд в локальной сети: HTTP по IP (боевой конфиг — flowpos.conf с TLS).
limit_req_zone \$binary_remote_addr zone=flowpos_login:10m rate=10r/m;
limit_req_zone \$binary_remote_addr zone=flowpos_api:10m rate=30r/s;
server {
    listen 80 default_server;
    server_name _;
    add_header X-Content-Type-Options nosniff always;
    add_header X-Frame-Options SAMEORIGIN always;
    client_max_body_size 25m;
    root /opt/flowpos/current/apps/web/dist;
    index index.html;
    location /assets/ { expires 1y; add_header Cache-Control "public, immutable"; try_files \$uri =404; }
    location = /api/v1/auth/login { limit_req zone=flowpos_login burst=5 nodelay; proxy_pass http://127.0.0.1:3000; include /etc/nginx/snippets/flowpos-proxy.conf; }
    location = /api/v1/ops/metrics { return 404; }
    location /api/ { limit_req zone=flowpos_api burst=60 nodelay; proxy_pass http://127.0.0.1:3000; include /etc/nginx/snippets/flowpos-proxy.conf; proxy_read_timeout 120s; }
    location / { try_files \$uri /index.html; add_header Cache-Control "no-cache"; }
}
NG
rm -f /etc/nginx/sites-enabled/default
ln -sfn /etc/nginx/sites-available/flowpos-lan.conf /etc/nginx/sites-enabled/flowpos-lan.conf
nginx -t && systemctl reload nginx
echo "== mDNS (<hostname>.local) и firewall — только локальная сеть"
DEBIAN_FRONTEND=noninteractive apt-get install -y avahi-daemon >/dev/null && systemctl enable --now avahi-daemon
NET=$(ip -4 -o addr show scope global | awk '{print $4}' | head -1 | sed -E 's#([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+/24#\1.0/24#')
ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw allow from "$NET" to any port 22 proto tcp comment 'SSH из локальной сети' >/dev/null
ufw allow from "$NET" to any port 80 proto tcp comment 'FlowPOS веб из локальной сети' >/dev/null
ufw allow from "$NET" to any port 5353 proto udp comment 'mDNS' >/dev/null
ufw --force enable >/dev/null
echo "== стенд подготовлен: http://$IP или http://$(hostname).local (сеть $NET)"
