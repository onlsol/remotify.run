#!/usr/bin/env bash
# Render .env from .env.example, overriding keys that are set as real environment
# variables (e.g. GitLab CI variables). Keys absent from .env.example are appended.
# Exits non-zero if DOMAIN remains unset after rendering.
set -euo pipefail

cp .env.example .env

for var in DOMAIN SCHEME PUBLIC_PORT NGINX_MODE HTTP_PORT HTTPS_PORT \
           RATE_LIMIT RATE_LIMIT_BURST PROXY_TIMEOUT MAX_BODY_SIZE \
           AUDIT_LOG SESSION_TTL SOURCE_URL CERTBOT_EMAIL CERTBOT_STAGING \
           COMPOSE_PROFILES; do
    val="${!var-}"
    [ -n "$val" ] || continue
    if grep -q "^${var}=" .env; then
        sed -i "s|^${var}=.*|${var}=${val}|" .env
    else
        printf '%s=%s\n' "$var" "$val" >> .env
    fi
done

grep -qE '^DOMAIN=.+' .env || { echo "DOMAIN must be set via CI variable"; exit 1; }
