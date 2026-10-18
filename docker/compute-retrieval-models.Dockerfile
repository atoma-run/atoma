# Derive from the exact tested base retrieval image. Provisioned models are
# copied at build time; execution remains entirely offline.
ARG RETRIEVAL_IMAGE
FROM ${RETRIEVAL_IMAGE}
COPY dist/compute-models/embedding /models/embedding
COPY dist/compute-models/reranker /models/reranker
COPY dist/compute-models/models.json /models/models.json
