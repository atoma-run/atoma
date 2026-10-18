# Multilingual Compute image publication — 2026-10-18

Revision: `a5b7bde7b24bd354f98efb3e740b727f644d5e2e`.
Tag: `compute-images-20261018-3`.
[Successful build, native tests and publication](https://github.com/atoma-run/atoma/actions/runs/39124781261).

All four runtime images were published for linux/arm64 and linux/amd64. Retrieval
now includes immutable multilingual model weights, source model cards, licenses
and content pins. Earlier BM25 images remain available under their old digests.

- Embeddings: [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small), MIT.
- Reranking: [cross-encoder/mmarco-mMiniLMv2-L12-H384-v1](https://huggingface.co/cross-encoder/mmarco-mMiniLMv2-L12-H384-v1), Apache-2.0.
- Reviewed upstream revisions, file sizes and SHA-256 hashes: `docker/compute-models.lock.json`.
- Runtime uses `query: ` and `passage: ` prefixes. Document prefix participates
  in the embedding-cache identity. Weights are downloaded only at image build;
  the production retrieval container has no network and a read-only root.

Each native architecture passed all 91 tests in six suites, with no skips.
The real hybrid pipeline includes 26 search assertions: each of the 13 Atoma
languages against three documents in that language and against three English
documents. The English control consequently runs twice. Every assertion requires
the relevant document to rank first. The fixture covers file recovery versus
weather and cooking distractors; this is a compatibility smoke, not a broad
multilingual relevance benchmark or a claim of equal quality across languages.
`language-smoke.json` preserves the individual results and fixture digest.

Both JSON receipt checksums were verified. All eight manifests and configuration
blobs were fetched with anonymous registry tokens after publication, hashed and
checked against the receipts, Linux architecture and source revision.
`registry-verification.json` records these checks. Both `haystackConfig` values
were accepted by Atoma's compiled launch schema. Set
`ATOMA_COMPUTE_HAYSTACK_CONFIG` to the matching receipt's `haystackConfig`; use
`images.retrieval.reference` when pairing the client. Keep all image pins from
the same architecture receipt. Worker allowlisting uses its `contentDigest`.

Local `release:check:static` and targeted Haystack/cache/configuration tests passed.
[Full CI at the published revision](https://github.com/atoma-run/atoma/actions/runs/39124777321)
passed: 7,570 tests / 51 skips in the general suite (524 passing / 5 skipped
files), 88 tests in the fresh worker job, 3 mender-isolation tests, and all static
release checks. The separate native publication job above exercised hybrid
retrieval without skipping it.
Native macOS/Windows acceptance remains deferred. No production deployment,
Electron work, capacity admission increase or server-resource claim is included.
