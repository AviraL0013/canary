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

# Build authorization service
RUN pnpm exec tsc -p services/authorization

WORKDIR /app/services/authorization

EXPOSE 3002

CMD ["node", "dist/server.js"]