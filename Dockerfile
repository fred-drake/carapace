# Carapace container image — multi-stage build
# Runtime is read-only (enforce with `docker run --read-only`).
# Writable paths at runtime: /workspace, /home/node/.claude/, /tmp

# ---------------------------------------------------------------------------
# Stage 1: builder — install deps and compile TypeScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

WORKDIR /build

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.check.json ./
COPY src/ src/
RUN pnpm run build

# Prune dev dependencies for production
RUN pnpm prune --prod

# ---------------------------------------------------------------------------
# Stage 2: runtime — minimal image for execution
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Install bash (Claude Code installer requires it) + curl for the installer
# Remove busybox wget symlink to reduce attack surface
RUN apk add --no-cache bash curl && rm -f /usr/bin/wget

# Claude Code version — override at build time: --build-arg CLAUDE_CODE_VERSION=2.1.49
# CI resolves latest automatically from the release channel URL:
#   curl -fsSL https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest
ARG CLAUDE_CODE_VERSION=latest
ENV DISABLE_AUTOUPDATER=1

# Image identity labels — passed by image-builder at build time
ARG CARAPACE_VERSION=dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown

RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION} && \
    ln -s /root/.local/bin/claude /usr/local/bin/claude

WORKDIR /app

# Copy production artifacts from builder (uses node user, UID 1000)
COPY --from=builder --chown=node:node /build/dist/ dist/
COPY --from=builder --chown=node:node /build/node_modules/ node_modules/
COPY --from=builder --chown=node:node /build/package.json package.json

# Create ipc wrapper script in PATH so Claude Code can invoke `ipc <topic> <args>`
RUN printf '#!/bin/sh\nexec node /app/dist/ipc/main.js "$@"\n' > /usr/local/bin/ipc && \
    chmod +x /usr/local/bin/ipc

# Copy entrypoint wrapper for credential injection
COPY --chown=node:node src/container/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create writable directories (for --read-only runtime)
RUN mkdir -p /workspace /run/zmq /home/node/.claude /tmp && \
    chown node:node /workspace /run/zmq /home/node/.claude

# OCI image labels for version tracking and staleness detection
LABEL org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${CARAPACE_VERSION}" \
      ai.carapace.claude-code-version="${CLAUDE_CODE_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}"

USER node

# Entrypoint reads credentials from stdin, then exec's into Claude Code
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
