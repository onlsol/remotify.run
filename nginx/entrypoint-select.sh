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
    CERT="${CERT_DIR}/fullchain.pem"
    # (Re)generate the bootstrap self-signed cert when there is none, OR when the
    # existing cert is still OUR self-signed one (subject == issuer) and is within
    # 2 days of expiry. The old 1-day cert would expire before a stalled certbot
    # (e.g. DNS not yet propagated) could replace it, wedging nginx on an EXPIRED
    # cert forever; a 90-day bootstrap plus this expiry check prevents that.
    need_bootstrap=0
    if [ ! -f "$CERT" ]; then
      need_bootstrap=1
    else
      subj=$(openssl x509 -in "$CERT" -noout -subject 2>/dev/null | sed 's/^subject= *//')
      issu=$(openssl x509 -in "$CERT" -noout -issuer  2>/dev/null | sed 's/^issuer= *//')
      if [ "$subj" = "$issu" ] && ! openssl x509 -in "$CERT" -noout -checkend 172800 2>/dev/null; then
        need_bootstrap=1
      fi
    fi
    if [ "$need_bootstrap" = 1 ]; then
      mkdir -p "${CERT_DIR}"
      openssl req -x509 -nodes -days 90 -newkey rsa:2048 \
        -keyout "${CERT_DIR}/privkey.pem" \
        -out    "$CERT" \
        -subj   "/CN=${DOMAIN}" \
        2>/dev/null
      echo "remotify-nginx: generated bootstrap self-signed cert for ${DOMAIN} (90d)"
    fi
    # Reload hourly so a certbot-renewed cert is picked up within the hour.
    (
      while :; do
        sleep 3600
        nginx -s reload 2>/dev/null || true
      done
    ) &
    ;;
  http|*)
    cp /etc/nginx/conf-sources/default.http.conf.template /etc/nginx/templates/default.conf.template
    ;;
esac
