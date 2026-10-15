# Fixed headed browser runtime; deployments select a capability, never an image.
FROM node:24-bookworm-slim AS desktop-copy
COPY src/viz/client/locales/en.json /build/en.json
COPY docker/hosting/browser-desktop.html /build/template.html
COPY scripts/build-hosted-browser-copy.mjs /build/render.mjs
RUN node /build/render.mjs /build/en.json /build/template.html /build/desktop.html

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox x11vnc novnc websockify fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10002 app
COPY docker/hosting/browser.mjs /opt/atoma-hosting/
COPY docker/hosting/package*.json /opt/atoma-hosting/
RUN cd /opt/atoma-hosting && npm ci --omit=dev --ignore-scripts && npm cache clean --force
ENV NODE_PATH=/opt/atoma-hosting/node_modules
COPY --from=desktop-copy /build/desktop.html /opt/atoma-hosting/browser-desktop.html
USER app
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT []
CMD []
