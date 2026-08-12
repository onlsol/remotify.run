#!/usr/bin/env bash
# Render .env from .env.example, overriding keys that are set as real environment
# variables (e.g. GitLab CI variables). Keys absent from .env.example are appended.
# Exits non-zero if DOMAIN is missing or is still the 'localhost' placeholder
# (unless ALLOW_LOCALHOST=1), so a prod deploy can never silently ship
# DOMAIN=localhost and hand out unreachable session URLs.
set -euo pipefail

cp .env.example .env

for var in DOMAIN SCHEME PUBLIC_PORT NGINX_MODE HTTP_PORT HTTPS_PORT \
           RATE_LIMIT RATE_LIMIT_BURST PROXY_TIMEOUT MAX_BODY_SIZE LONGPOLL_MS \
           FPM_MAX_CHILDREN AUDIT_LOG SESSION_TTL SOURCE_URL \
           CERTBOT_EMAIL CERTBOT_STAGING COMPOSE_PROFILES; do
    val="${!var-}"
    [ -n "$val" ] || continue
    # Escape sed replacement metacharacters (\, &, and the | delimiter) so a
    # value like a SOURCE_URL containing '&' cannot corrupt the rendered .env.
    val_esc=$(printf '%s' "$val" | sed -e 's/[\\&|]/\\&/g')
    if grep -q "^${var}=" .env; then
        sed -i "s|^${var}=.*|${var}=${val_esc}|" .env
    else
        printf '%s=%s\n' "$var" "$val" >> .env
    fi
done

dom=$(sed -n 's/^DOMAIN=//p' .env | head -1)
if [ -z "$dom" ]; then
    echo "render-env: DOMAIN must be set (via .env.example or a CI variable)" >&2
    exit 1
fi
if [ "$dom" = "localhost" ] && [ "${ALLOW_LOCALHOST:-0}" != "1" ]; then
    echo "render-env: DOMAIN is still 'localhost' - refusing to render for deploy." >&2
    echo "            Set the DOMAIN environment/CI variable, or ALLOW_LOCALHOST=1 for local use." >&2
    exit 1
fi
