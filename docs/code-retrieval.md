# Structured code retrieval through Haystack

Atoma uses its existing Haystack backend for documentation and TypeScript/JavaScript
code. The client entry point is `atoma_run_search` with `projectId`, `runId`,
`query`, optional `filters`, `includeRelated`, `limit` and `maxExcerptBytes`.
The HTTP equivalent is GET `/api/projects/:project/runs/:run/search` (filters
are a JSON query parameter). Molecules use the existing `search_project_docs`
element with the same search arguments, without choosing project authority.

## Sources and identity

Runs archive their actual starting repository seed before execution, including
imports from GitHub and repository reconciliation. A continuation reuses the
recorded starting corpus. Client searches read retained delivered/partial
artifacts; neither search reads a live worker workspace. Results carry snapshot,
source hashes and exact byte/line citations. Read current files before editing.

The existing file policy excludes secrets, dependencies and symlinks. Admission
is bounded by 200 files and 8 MB total; eligible documentation precedes code,
then paths sort deterministically. `coverage` states eligible, indexed and omitted
files. Unsupported formats are outside eligible coverage. Executable TS/JS files
may be read as text, never executed. Existing receipts retain their identities.

## Code structure

The pinned TypeScript parser extracts top-level declarations, class/interface
members, signatures and static imports/exports from TS, TSX, JS, JSX, MTS, CTS,
MJS and CJS. Chunk boundaries prefer declarations, with the existing byte/line
caps splitting large symbols. Excerpts remain original text; symbol names and
split camel-case identifiers decorate Haystack's searchable context.

Only unambiguous relative imports resolving to admitted sources form `imports`
and `imported-by` edges. This includes importing tests, without claiming they
cover a behaviour. Package imports, tsconfig aliases, CommonJS require, dynamic
imports and a full call graph are not resolved. Syntax errors are reported and
withhold edges. At most 20 edges are returned per file, with truncation stated.

Haystack still ranks with BM25 or the configured hybrid fusion/reranker. With
`includeRelated`, the first match is followed by bounded excerpts of its resolved
neighbouring files, within the same filters and response budget. These neighbours
are dependency context, not additional relevance scores or correctness evidence.

## Authority and resource bounds

The shared client reader checks access before ingestion and after ranking,
revalidates artifact bytes, and closes its process on every exit. It admits at
most two client indexes concurrently, bounds preparation to two minutes and uses
the existing search timeout and response caps. No persistent index, alternative
ranking backend or paid model API is introduced. An unavailable backend is an
explicit failure, never an empty successful search.

## Evaluation

After building, run:

```sh
node benchmark/code-retrieval/evaluate.mjs /absolute/path/to/python
```

The frozen synthetic corpus has three modification tasks and six files. Both
arms use real Haystack BM25, identical sources, queries and response limits.
The control uses the previous line chunker; treatment uses symbols and file
relations. Output records expected-file recall, excerpt/response bytes,
preparation/query time and zero paid calls. It evaluates retrieval, not generated
patch correctness or production cost savings. Tests separately cover literal
citations, filters, revocation, tampering, continuation and MCP transport.

The paired BM25 and configured hybrid results are retained with the
[evaluation fixture](../benchmark/code-retrieval/README.md).
