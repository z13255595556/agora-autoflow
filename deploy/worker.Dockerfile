FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# worker 直接跑 TS 源码（--experimental-strip-types），不需要构建步骤 ——
# 它和前端共用 src/lib/engine-core，编译一遍反而多一层不一致的可能
COPY src/ ./src/
COPY worker/ ./worker/
COPY --chmod=755 deploy/load-db-secret.sh /usr/local/bin/load-db-secret
ENTRYPOINT ["/usr/local/bin/load-db-secret"]
CMD ["node", "--experimental-strip-types", "worker/index.ts"]
