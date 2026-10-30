# Multilingual project search on the server — 2026-10-30

Until this change, Compute devices searched project documents with multilingual
models (since `a5b7bde7`, 2026-10-18), but runs hosted on the server still used
the English models provisioned on 2026-09-09: `BAAI/bge-small-en` and
`cross-encoder/ms-marco-MiniLM-L-12-v2`. A project without a Compute device runs
on the server by default, so the 13 Atoma locales were not covered there.

## Change

- Models copied out of the published Compute retrieval image
  `ghcr.io/atoma-run/atoma/compute-retrieval@sha256:6dec1de79055c3875818265a3de851a4175c2ba656e047019b06ef079470f971`
  (linux/amd64 receipt of revision `344f81f5`) into `/home/atoma/haystack-20261030/`:
  `intfloat/multilingual-e5-small` and `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1`.
- `haystack:config` from the deployed release (`ea622f14`) computed the content
  pins `8481cae1…` (embedding) and `b4ef9bdd…` (reranker), identical to the
  receipt and to the configuration of the paired Compute device.
- The Python environment is unchanged (`/home/atoma/haystack-20260909/venv`,
  runtime `99af176f…`), so only the model paths, revisions and the
  `query: ` / `passage: ` prefixes changed in `ATOMA_HAYSTACK_CONFIG`.
- Previous environment file kept as
  `/home/atoma/config/atoma.env.before-multilingual-haystack-20261030T100043Z`.
  The previous model directory is still in place for rollback.

## Check

[`multilingual-smoke.mjs`](multilingual-smoke.mjs) drives the deployed release's
own corpus preparation, Haystack binding and retrieval tool with the host
Python, over `tests/fixtures/compute-retrieval-languages.json`: for each locale,
its query against three documents in its own language and against three
English documents; the relevant document must rank first.

| Configuration | Passed | Peak Python RSS | Ready in |
|---|---|---|---|
| English (2026-09-09) | 16 / 26 | 686 MB | 8.3 s |
| Multilingual (2026-10-30) | 26 / 26 | 1,438 MB | 10.8–23.7 s |

All ten English failures were cross-language queries (de, es, ru, zh, ja, ar,
hi, bn, ur, id against English documents). One sample on the 4-CPU production
host, three documents per language: a compatibility check, not a relevance
benchmark or a claim of equal quality across languages. Preparation time on a
large corpus was not measured; the first hosted run of each project re-embeds
its documents because the embedding cache key includes the model revision and
document prefix.
