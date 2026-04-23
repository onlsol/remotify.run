FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY entrypoint-select.sh /docker-entrypoint.d/15-remotify-select.sh
RUN chmod +x /docker-entrypoint.d/15-remotify-select.sh

COPY templates /etc/nginx/conf-sources
COPY public    /usr/share/nginx/html

# Seed the host-mounted webroot path so certbot --webroot works on first run.
RUN mkdir -p /var/www/certbot
