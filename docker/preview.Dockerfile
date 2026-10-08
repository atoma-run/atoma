# A delivered application or the fixed CLI testing service. No control-plane
# modules, stores, tools, credentials or container engine enter this image.
FROM node:24-slim

# Python supplies the kernel PTY bridge; bash supplies the interactive shell.
# Deliverable dependencies are copied with the workspace, never installed on open.
RUN apt-get update && apt-get install -y --no-install-recommends python3 bash \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080
RUN useradd -m -u 10002 preview && mkdir -p /app && chown preview /app
COPY dist/preview-terminal/ /opt/atoma-terminal/
USER preview
WORKDIR /app
EXPOSE 8080
# The launcher selects node <delivered entry> or the fixed terminal service.
# Runtime, networks, read-only root, workspace mounts and bounds are its policy.
ENTRYPOINT []
CMD []
