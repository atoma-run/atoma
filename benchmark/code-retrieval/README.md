# Code retrieval development comparison

`evaluate.mjs` freezes three synthetic modification requests and six source files
before either arm executes. Both arms use the same source bytes, queries and
limit of two passages, and the real host Haystack subprocess. The control is the
previous line chunker applied to code; code was not previously admitted in
production. The treatment combines symbol chunks, symbol context and one-hop
file relations, so this is not an ablation of each mechanism.

Run after `npm run build`:

```sh
node benchmark/code-retrieval/evaluate.mjs /absolute/python
# With the host's existing ATOMA_HAYSTACK_CONFIG:
node benchmark/code-retrieval/evaluate.mjs --configured
```

Saved runs: `bm25-results.json` and `hybrid-results.json`. Both treatments
retrieved both expected files on all three tasks. The line control retrieved
both files on one task with BM25 and two tasks with hybrid reranking. Each result
records bytes, timings, runtime and compiled implementation hashes. Measurements
use local inference and zero paid API calls. Three synthetic cases cannot establish
production savings, end-to-end patch correctness, or reliable latency comparisons.
The fixture intentionally includes unrelated code to test context selection.

Unit/process tests independently cover citations, parsing, bounded admission,
authority, tampering, both MCP eras, HTTP validation and the compiled release.
