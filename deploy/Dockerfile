# CrabHub Web — self-hosted deployment image.
#
# Build:  docker build -t crabhub .
# Run:    docker run -d -p 4224:4224 \
#           -e CRABHUB_WEB_PASSWORD=change-me \
#           -e CRABHUB_MASTER_KEY=change-me-too-16ch \
#           -v crabhub-data:/app/data crabhub

# --- Stage 1: frontend ---
FROM node:20-slim AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json ./
COPY public ./public
COPY src ./src
RUN npm run build

# --- Stage 2: server binary ---
FROM rust:1.83-slim AS backend
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev perl make && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY src-tauri ./src-tauri
# The Tauri desktop binary needs a webview toolchain; the server binary does
# not. Build only crabhub-server so the image stays slim and CI stays fast.
RUN cd src-tauri && cargo build --release --bin crabhub-server

# --- Stage 3: runtime ---
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates && rm -rf /var/lib/apt/lists/* \
    && useradd -r -m -d /app crabhub
WORKDIR /app
COPY --from=backend /build/src-tauri/target/release/crabhub-server /usr/local/bin/crabhub-server
COPY --from=frontend /build/dist /app/dist
USER crabhub

ENV CRABHUB_BIND=0.0.0.0 \
    CRABHUB_WEB_PORT=4224 \
    CRABHUB_DATA_DIR=/app/data \
    CRABHUB_STATIC_DIR=/app/dist

EXPOSE 4224
VOLUME ["/app/data"]
ENTRYPOINT ["crabhub-server"]
