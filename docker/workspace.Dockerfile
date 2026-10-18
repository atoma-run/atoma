# Private workspace control service. Never shares a process or control endpoint
# with model-authored commands. Its private snapshot volume is never mounted
# into the element worker.
FROM node:24-slim
WORKDIR /app
COPY dist/workspace-service/service.mjs /app/service.mjs
COPY dist/compute-preview/copy.mjs /app/preview-copy.mjs
RUN mkdir /workspace /snapshots /preview && chown 10001:10001 /workspace /snapshots /preview
USER 10001:10001
ENV ATOMA_WORKSPACE_ROOT=/workspace/current
ENV TMPDIR=/snapshots
CMD ["node", "/app/service.mjs"]
