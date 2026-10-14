# Fixed hosting runtime. Generated projects never choose engine flags or images.
FROM node:24-slim
COPY docker/hosting/static.mjs /opt/atoma-hosting/static.mjs
RUN useradd -m -u 10002 app
USER app
WORKDIR /workspace
EXPOSE 8080
ENTRYPOINT []
CMD []
