ARG BUILD_FROM=postgres:16-alpine
FROM ${BUILD_FROM}

RUN apk add --no-cache bash jq su-exec

COPY run.sh /run.sh
RUN chmod +x /run.sh

EXPOSE 5432

CMD [ "/run.sh" ]
