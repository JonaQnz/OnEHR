# syntax=docker/dockerfile:1.7

# Single production image for OnEHR: the API serves the built SPA from
# WEB_DIST_DIR, so one image backs both apps. The dev stack keeps using
# Dockerfile.api, Dockerfile.web and docker-compose.yml unchanged.

# Base stage: shared Node 22 + openssl for Prisma.
FROM node:22-slim AS base
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Build stage: every workspace, the Prisma client, apps/api and apps/web.
FROM base AS build
COPY . .
RUN npm ci --no-audit --no-fund
RUN npx prisma generate --schema=apps/api/prisma/schema.prisma
RUN npm run build --workspace=core
RUN npm run build:lib --workspace=react-form-builder2
RUN npm run build:packages
RUN cd apps/api && npm run build
RUN VITE_API_URL=/ npm run build --workspace=web

# Runtime stage: full /app tree (node_modules, built packages, api, web).
FROM base AS runtime
COPY --from=build /app /app
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    PORT=3001 \
    WEB_DIST_DIR=/app/apps/web/dist \
    DATA_DIR=/app/data
RUN mkdir -p /app/data
EXPOSE 3001
# Schema pushes that would drop data must fail and trigger a rollback
# instead of silently destroying data, so no destructive flag is passed.
CMD ["sh", "-c", "cd apps/api && npx prisma db push --skip-generate --schema=prisma/schema.prisma && node dist/index.js"]
