# Web e worker usam a mesma imagem e a mesma versão do runtime.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache --virtual .native-build-deps build-base cmake git python3 openblas-dev lapack-dev && npm ci && apk del .native-build-deps

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# O standalone traz um node_modules rastreado (~400 MB) que a imagem final cobre com o
# node_modules de produção completo, no mesmo caminho: sem apagá-lo aqui, a cópia ficava
# perdida numa camada de baixo e cada imagem crescia esse tanto. O worker roda lib/*.ts fora
# do Next e precisa do node_modules completo; só o rastreado não basta.
RUN npm run build && rm -rf .next/standalone/node_modules

FROM deps AS production-deps
RUN npm prune --omit=dev

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=10000 HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN apk add --no-cache libstdc++ libgomp openblas && addgroup -S app && adduser -S app -G app && mkdir -p /app/data && chown app:app /app/data
COPY --from=build /app/public ./public
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/package.json ./package.json
USER app
# Arquivos privados persistem no volume; no SaaS, banco e chave vêm do ambiente.
VOLUME ["/app/data"]
EXPOSE 10000
CMD ["node", "server.js"]
