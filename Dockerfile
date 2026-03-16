# ============================================
# Stage 1: Dependencies Installation Stage
# ============================================

# IMPORTANT: Node.js Version Maintenance
# This Dockerfile uses Node.js 24.13.0-slim, which was the latest LTS version at the time of writing.
# To ensure security and compatibility, regularly update the NODE_VERSION ARG to the latest LTS version.
ARG NODE_VERSION=24.13.0-slim
ARG BUN_VERSION=1.2.8

FROM oven/bun:${BUN_VERSION} AS bun

FROM node:${NODE_VERSION} AS dependencies

# Set working directory
WORKDIR /app

# Install Bun by copying the official binary (no npm usage).
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx

# Copy package-related files first to leverage Docker's caching mechanism
COPY package.json bun.lock* .npmrc* ./

# Install project dependencies with frozen lockfile for reproducible builds
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile

# ============================================
# Stage 2: Build Next.js application in standalone mode
# ============================================

FROM node:${NODE_VERSION} AS builder

# Set working directory
WORKDIR /app

# Install Bun by copying the official binary (no npm usage).
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=bun /usr/local/bin/bunx /usr/local/bin/bunx

# Copy project dependencies from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source code
COPY . .

ENV NODE_ENV=production

# Build Next.js application
RUN export DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/placeholder \
    GROQ_API_KEY=placeholder \
    COHERE_API_KEY=placeholder \
    GROQ_MODEL=placeholder-model && \
  bun run build

# ============================================
# Stage 3: Run Next.js application
# ============================================

FROM node:${NODE_VERSION} AS runner

# Set working directory
WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=5000
ENV HOSTNAME=0.0.0.0

# Copy production assets
COPY --from=builder --chown=node:node /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next && chown node:node .next

# Automatically leverage output traces to reduce image size
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Switch to non-root user for security best practices
USER node

# Expose port 5000 to allow HTTP traffic
EXPOSE 5000

# Start Next.js standalone server
CMD ["node", "server.js"]
