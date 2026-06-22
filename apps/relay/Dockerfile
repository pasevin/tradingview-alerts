# Multi-stage build keeps the native better-sqlite3 binary matched to the
# runtime image. node_modules is rebuilt INSIDE the image — never copy a
# host-built binary in, or it crashes with "invalid ELF header".
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# Build context is the monorepo root (see fly.toml build.dockerfile path note).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/protocol ./packages/protocol
COPY apps/relay ./apps/relay
RUN pnpm install --filter @tvalert/relay... --frozen-lockfile=false
RUN pnpm --filter @tvalert/protocol build && pnpm --filter @tvalert/relay build
RUN pnpm --filter @tvalert/relay deploy --prod /out
# Copy non-JS assets that pnpm deploy doesn't include
COPY apps/relay/site.html /out/site.html

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
VOLUME /data
EXPOSE 8787
CMD ["node", "dist/server.js"]
