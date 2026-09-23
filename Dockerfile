# A imagem oficial do Playwright já traz o Chromium e todas as bibliotecas de sistema.
# A versão tem de bater com a do pacote "playwright" no package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public

# Easypanel passa o commit em GIT_SHA — aparece em /api/versao para confirmar o deploy.
ARG GIT_SHA=desconhecida
ENV GIT_SHA=$GIT_SHA

VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
