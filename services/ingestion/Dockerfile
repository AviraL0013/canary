FROM node:20-alpine AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

# Copy workspace manifests
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/event-schema/package.json ./packages/event-schema/
COPY packages/graph-core/package.json ./packages/graph-core/
COPY packages/authorization-engine/package.json ./packages/authorization-engine/
COPY services/ingestion/package.json ./services/ingestion/

# Install all deps
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/event-schema/ ./packages/event-schema/
COPY packages/graph-core/ ./packages/graph-core/
COPY packages/authorization-engine/ ./packages/authorization-engine/
COPY services/ingestion/ ./services/ingestion/

# Build
RUN pnpm --filter @canary/event-schema run build
RUN pnpm --filter @canary/graph-core run build
RUN pnpm --filter @canary/authorization-engine run build
RUN pnpm --filter @canary/ingestion run build

WORKDIR /app/services/ingestion
EXPOSE 3001
CMD ["node", "dist/server.js"]
