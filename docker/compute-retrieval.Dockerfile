# Private retrieval runtime. No product store, provider credentials, tool worker,
# engine socket or control-plane entrypoint is installed here.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv python3-dev make g++ libreoffice-core libreoffice-writer libreoffice-calc libreoffice-impress && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY dist/compute-retrieval/package.json /app/package.json
RUN npm install --omit=dev && npm cache clean --force && ln -s /app/node_modules /node_modules
COPY dist/compute-retrieval/requirements-haystack*.txt /requirements/
RUN python3 -m venv /opt/haystack && /opt/haystack/bin/pip install --no-cache-dir --no-deps --index-url https://download.pytorch.org/whl/cpu torch==2.14.0 \
    && /opt/haystack/bin/pip install --no-cache-dir -r /requirements/requirements-haystack-hybrid.txt
COPY dist/compute-retrieval/service.mjs /app/service.mjs
COPY dist/compute-retrieval/retrieval-haystack.py dist/compute-retrieval/retrieval-extract.mjs /scripts/
RUN useradd --uid 10001 --home-dir /tmp --no-create-home compute && mkdir /retrieval /cache /models && chown 10001:10001 /retrieval /cache
USER 10001:10001
ENV ATOMA_RETRIEVAL_ROOT=/retrieval
ENV TMPDIR=/tmp
CMD ["node", "/app/service.mjs"]
# Hybrid installations derive an immutable image with their pinned offline model
# directories at /models/embedding and /models/reranker. Revision checks are
# mandatory before a corpus is indexed; no downloads happen during execution.
