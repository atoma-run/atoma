FROM node:24.20.0-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ chromium ca-certificates procps \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code
WORKDIR /work

# Every command gets a fresh container. Keep the browser in the image, as the
# tool worker does, rather than downloading it into a disposable /tmp cache.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# The official Node image already contains matching build headers. Reuse them
# instead of downloading and duplicating them in the bounded 512 MiB tmpfs.
ENV npm_package_config_node_gyp_nodedir=/usr/local
RUN test -r /usr/local/include/node/node.h \
    && test -r /usr/local/include/node/common.gypi \
    && test -r /usr/local/include/node/config.gypi
