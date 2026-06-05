# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
ARG NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
# Dummy DATABASE_URL so Next.js can import route modules during page-data collection.
# Real value is supplied at runtime via env_file. No DB connection is made during build.
RUN DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy npm run build

FROM base AS runtime
ENV NODE_ENV=production
# Drop privileges: the node:* base images ship a non-root `node` user (uid 1000).
# Copy app files owned by it so web (next start, writes .next/cache) and worker
# (tsx) run unprivileged — any code-exec/file-write primitive is then non-root.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=build --chown=node:node /app/prisma.config.ts ./prisma.config.ts
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
USER node
EXPOSE 3000
CMD ["npm", "start"]
