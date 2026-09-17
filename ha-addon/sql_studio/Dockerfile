ARG BUILD_FROM=alpine:3.20
FROM ${BUILD_FROM}

RUN apk add --no-cache \
    bash \
    curl \
    jq \
    php83 \
    php83-session \
    php83-pgsql \
    php83-pdo_pgsql \
    php83-json \
    php83-mbstring \
    php83-openssl

WORKDIR /app

# Download official Adminer & Hydra dark theme
RUN curl -fsSL https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1.php -o /app/adminer.php && \
    curl -fsSL https://raw.githubusercontent.com/vrana/adminer/master/designs/hydra/adminer.css -o /app/adminer.css

COPY index.php /app/index.php
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8080

CMD [ "/run.sh" ]
