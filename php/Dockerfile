FROM php:8.3-fpm-alpine

RUN mkdir -p /var/data/sessions && chown -R www-data:www-data /var/data

RUN { \
    echo 'post_max_size = 30M';        \
    echo 'upload_max_filesize = 30M';  \
    echo 'memory_limit = 256M';        \
    } > /usr/local/etc/php/conf.d/99-remotify.ini

COPY docker-entrypoint.sh /usr/local/bin/remotify-entrypoint.sh
RUN chmod +x /usr/local/bin/remotify-entrypoint.sh

WORKDIR /var/www/html
COPY app/ /var/www/html/
RUN chown -R www-data:www-data /var/www/html

ENTRYPOINT ["/usr/local/bin/remotify-entrypoint.sh"]
CMD ["php-fpm"]
