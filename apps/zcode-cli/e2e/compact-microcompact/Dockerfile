# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24.14-alpine
FROM ${NODE_IMAGE}

ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG MBEARS_NPM_CONFIG_REGISTRY=https://registry.npmjs.org/
ARG INSTALL_CA_CERTIFICATES=false
ENV npm_config_registry=${NPM_CONFIG_REGISTRY}

WORKDIR /repo

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

RUN if [ "${INSTALL_CA_CERTIFICATES}" = "true" ]; then \
    if command -v apk >/dev/null 2>&1; then \
      apk add --no-cache ca-certificates; \
    elif command -v apt-get >/dev/null 2>&1; then \
      apt-get update && \
      apt-get install -y --no-install-recommends ca-certificates && \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
  fi
RUN corepack enable

# CLI 依赖根 workspace 包；构建上下文必须是仓库根，不能重新建立一套子锁。
COPY . .

RUN --mount=type=cache,id=zcode-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store && \
  pnpm config set @mbears:registry ${MBEARS_NPM_CONFIG_REGISTRY} && \
  pnpm config set fetch-retries 5 && \
  pnpm config set fetch-retry-maxtimeout 120000 && \
  pnpm config set fetch-timeout 300000 && \
  pnpm install --frozen-lockfile --filter zcode --filter zcode-cli --filter @zcode/cli...

RUN pnpm --filter @zcode/cli... build

ENTRYPOINT ["node", "apps/zcode-cli/e2e/compact-microcompact/run.mjs"]
