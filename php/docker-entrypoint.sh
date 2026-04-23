#!/bin/sh
# Ensure the bind-mounted data dir is owned by the php worker user; then
# delegate to the stock php image entrypoint.
set -e
if [ -d /var/data ]; then
    chown -R www-data:www-data /var/data || true
    chmod -R a+rX /var/data || true
fi
exec docker-php-entrypoint "$@"
