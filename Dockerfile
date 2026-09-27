# ---------- 构建阶段：安装全部依赖并编译 ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 原生模块（better-sqlite3）优先使用预编译二进制；下载不可用时回退源码编译
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

COPY server/ server/
COPY client/ client/
RUN npm run build

# ---------- 生产依赖阶段：仅安装运行时依赖 ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev

# ---------- 运行时 ----------
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/evidence.db \
    CLIENT_DIST=/app/client/dist
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
CMD ["node", "server/dist/index.js"]
