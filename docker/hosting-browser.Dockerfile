# Fixed headed browser runtime; deployments select a capability, never an image.
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb openbox x11vnc novnc websockify fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10002 app
COPY docker/hosting/browser.mjs /opt/atoma-hosting/browser.mjs
USER app
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT []
CMD []
