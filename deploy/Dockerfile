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
FROM rust:1-slim-bookworm AS backend
# The lib crate links tauri (gtk/glib on Linux), so the gtk dev headers are
# needed at BUILD time even though crabhub-server never opens a window.
# The runtime stage stays slim: with `--as-needed` the unused gtk shared
# libraries are not recorded in the final binary.
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev perl make build-essential \
    libwebkit2gtk-4.1-dev libgtk-3-dev libappindicator3-dev librsvg2-dev patchelf \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY src-tauri ./src-tauri
# build.rs runs tauri_build even for the server binary and validates
# tauri.conf.json's frontendDist (../dist), so copy the frontend output before
# cargo build.
COPY --from=frontend /build/dist ./dist
# Build only crabhub-server so the image stays slimmer and CI stays faster than
# bundling the desktop app.
RUN cd src-tauri && cargo build --release --bin crabhub-server

# --- Stage 3: runtime ---
FROM debian:bookworm-slim
# The binary carries gtk/webkit NEEDED entries via the shared tauri lib crate;
# install the runtime (non-dev) libraries alongside CA certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libwebkit2gtk-4.1-0 libgtk-3-0 librsvg2-2 \
    && rm -rf /var/lib/apt/lists/* \
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
