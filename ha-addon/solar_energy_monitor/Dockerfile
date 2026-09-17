ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /usr/src/app

RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY env.js service.js ha-mqtt.js cps-auth.js cps-sync.js db-logger.js ./
COPY cps-dashboard ./cps-dashboard
COPY cps-history.json ./cps-history-seed.json

EXPOSE 3355

CMD [ "node", "service.js" ]
