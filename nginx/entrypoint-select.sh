#!/bin/sh
# Pick the correct nginx config template for HTTP or TLS mode, and (for TLS)
# generate a throwaway self-signed cert so nginx can boot before certbot issues
# the real one.
set -e

: "${DOMAIN:=localhost}"
: "${NGINX_MODE:=http}"

mkdir -p /etc/nginx/templates

case "$NGINX_MODE" in
  tls|https)
    cp /etc/nginx/conf-sources/default.tls.conf.template /etc/nginx/templates/default.conf.template
    CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
    if [ ! -f "${CERT_DIR}/fullchain.pem" ]; then
      mkdir -p "${CERT_DIR}"
      openssl req -x509 -nodes -days 1 -newkey rsa:2048 \
        -keyout "${CERT_DIR}/privkey.pem" \
        -out    "${CERT_DIR}/fullchain.pem" \
        -subj   "/CN=${DOMAIN}" \
        2>/dev/null
      echo "remotify-nginx: generated bootstrap self-signed cert for ${DOMAIN}"
    fi
    # Reload every 6h so renewed certs are picked up without restarting the container.
    (
      while :; do
        sleep 21600
        nginx -s reload 2>/dev/null || true
      done
    ) &
    ;;
  http|*)
    cp /etc/nginx/conf-sources/default.http.conf.template /etc/nginx/templates/default.conf.template
    ;;
esac
