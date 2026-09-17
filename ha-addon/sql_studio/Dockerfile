ARG BUILD_FROM=alpine:3.20
FROM ${BUILD_FROM}

RUN apk add --no-cache bash jq ca-certificates

WORKDIR /app

COPY pgweb /usr/local/bin/pgweb
RUN chmod +x /usr/local/bin/pgweb

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 8080 8085

CMD [ "/run.sh" ]
