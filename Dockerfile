# Imagem da aplicação.
# Estágio 1 ("deps"): instala só as dependências de produção.
FROM oven/bun:1.4.4-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Estágio 2 ("runtime"): imagem final, só com o necessário para rodar.
FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
# Não roda como root (boa prática de segurança).
USER bun
EXPOSE 3000
CMD ["bun", "run", "src/main.ts"]
