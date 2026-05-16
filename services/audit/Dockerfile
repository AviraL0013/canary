FROM node:20-alpine AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/event-schema/package.json ./packages/event-schema/
COPY packages/graph-core/package.json ./packages/graph-core/
COPY packages/authorization-engine/package.json ./packages/authorization-engine/
COPY services/audit/package.json ./services/audit/

RUN pnpm install --frozen-lockfile

COPY packages/event-schema/ ./packages/event-schema/
COPY packages/graph-core/ ./packages/graph-core/
COPY packages/authorization-engine/ ./packages/authorization-engine/
COPY services/audit/ ./services/audit/

RUN pnpm --filter @canary/event-schema run build
RUN pnpm --filter @canary/graph-core run build
RUN pnpm --filter @canary/authorization-engine run build
RUN pnpm --filter @canary/audit run build

WORKDIR /app/services/audit
EXPOSE 3003
CMD ["node", "dist/server.js"]
