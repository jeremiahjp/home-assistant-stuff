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

COPY adminer.php adminer.css index.php /app/
COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8080

CMD [ "/run.sh" ]
