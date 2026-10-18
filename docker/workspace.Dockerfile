# Private workspace control service. Never shares a process or control endpoint
# with model-authored commands. Its private snapshot volume is never mounted
# into the element worker.
FROM node:24-slim
WORKDIR /app
COPY dist/workspace-service/service.mjs /app/service.mjs
RUN mkdir /workspace /snapshots && chown 10001:10001 /workspace /snapshots
USER 10001:10001
ENV ATOMA_WORKSPACE_ROOT=/workspace
ENV TMPDIR=/snapshots
CMD ["node", "/app/service.mjs"]
