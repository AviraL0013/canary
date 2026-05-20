FROM node:20

RUN npm install -g pnpm@9.15.0

WORKDIR /app

# Copy entire monorepo
COPY . .

# Install workspace dependencies
RUN pnpm install -r --frozen-lockfile

# Remove stale TS cache
RUN find . -name "*.tsbuildinfo" -delete

# Build shared packages
RUN pnpm exec tsc -p packages/event-schema
RUN pnpm exec tsc -p packages/graph-core
RUN pnpm exec tsc -p packages/authorization-engine

# Build audit service
RUN pnpm exec tsc -p services/audit

WORKDIR /app/services/audit

EXPOSE 3003

CMD ["node", "dist/server.js"]