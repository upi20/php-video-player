# Telegram bridge: a long-running PHP process (MadelineProto + amphp HTTP server).
FROM composer:2 AS vendor
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-progress --ignore-platform-reqs --optimize-autoloader

FROM php:8.3-cli
# gmp speeds up MadelineProto's crypto; pcntl lets the server stop cleanly on SIGTERM.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgmp-dev \
    && docker-php-ext-install gmp pcntl \
    && rm -rf /var/lib/apt/lists/* \
    && echo "memory_limit=1G" > /usr/local/etc/php/conf.d/telegram.ini \
    && mkdir -p /session && chown www-data:www-data /session
WORKDIR /app
COPY --from=vendor /app/vendor /app/vendor
COPY server.php /app/server.php
USER www-data
CMD ["php", "/app/server.php"]
