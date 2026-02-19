# Carapace container image — multi-stage build
# Runtime is read-only (enforce with `docker run --read-only`).
# Writable paths at runtime: /workspace, /run/zmq

# ---------------------------------------------------------------------------
# Stage 1: builder — install deps and compile TypeScript
# ---------------------------------------------------------------------------
FROM node:22-slim AS builder

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
FROM node:22-slim AS runtime

# Install libzmq for ZeroMQ native bindings
RUN apt-get update && apt-get install -y --no-install-recommends \
    libzmq5 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for security
RUN groupadd --gid 1001 carapace && \
    useradd --uid 1001 --gid carapace --shell /bin/false --create-home carapace

WORKDIR /app

# Copy production artifacts from builder
COPY --from=builder --chown=carapace:carapace /build/dist/ dist/
COPY --from=builder --chown=carapace:carapace /build/node_modules/ node_modules/
COPY --from=builder --chown=carapace:carapace /build/package.json package.json

# Create writable directories (for --read-only runtime)
RUN mkdir -p /workspace /run/zmq && \
    chown carapace:carapace /workspace /run/zmq

USER carapace

# Default entrypoint — can be overridden by orchestrator
ENTRYPOINT ["node", "dist/index.js"]
