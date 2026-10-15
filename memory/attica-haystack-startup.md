# Attica startup latency — 2026-10-15

Read-only investigation requested by the owner. Production MCP identified
project `07864f7c-d8f2-4023-9fca-afd8a7a51e52`; summary pages and runner logs
were read to their available ends. SSH was used only after MCP lacked CPU
and retrieval-corpus diagnostics. No run was started, cancelled or changed.

## Evidence

- Current run `85cc4e83-b84d-48a3-93b0-ae25688b7e0a`: admitted
  02:10:35.487 UTC, trace begins 02:10:40.822, first event 02:17:09.827,
  first LLM starts 02:17:10.597. Pre-event interval **389.005 s** (6m29),
  admission to first event 394.340 s. Revision `a01d8d7dde7ff35a31106845b6bdea49396179ca`.
- Previous run `7b126338-d494-4edb-b793-de6298669eeb`: 413.201 s
  before its first event; 67.007 s from first event to trace completion.
  All 38 events read; zero `search_project_docs` calls.
- Previous run `30e53f08-120b-4526-a90a-8f03c178065c`: 389.574 s
  before its first event; 74.270 s afterwards. All 41 events read;
  zero `search_project_docs` calls. Revision `6ff6d1440f210e47f7d6ea024ad5e59da9e0fa8a`.
- Live Python PID 577303 belongs to current run. At 02:16:56 UTC:
  375.61 s elapsed, 375.30 s CPU, running, only embedding weights mapped.
  At 02:17:55: sleeping, 388.05 s accumulated CPU, 789.3 MiB RSS.
  Host has four logical CPUs; runtime explicitly sets one torch/OMP/MKL
  thread. Config is `hybrid-rerank`, CPU models, offline/local weights.
- Read-only production receipt: 43 admitted documents, 1,120,906 bytes,
  all 43 path/hash pairs identical to the previous run's corpus. CSVs:
  917,974 bytes (81.90%). Largest is
  `data/xe-live-2026-10-14/listings.csv` (788,108 bytes).
- Read-only replay of deployed `prepareProjectRetrievalCorpus` on the
  immutable source archive: 198 ms, 1,424 passages, including 735 CSV
  passages (51.62%), plus 389,355 bytes of searchable context. No Python
  model or paid provider was launched for this measurement. One sample,
  not a cold-cache benchmark.

## Cause and next change

`src/run/runner.ts` awaits `prepareRetrieval` before `handle`.
`scripts/retrieval-haystack.py` creates a fresh in-memory store, loads local
CPU models and embeds every passage before returning ready. No embedding
cache survives a run. Its deployed SHA-256 matches the local script:
`540ea453c586444927c84a1aa6c51568a78c22be52a76d12de4911e85b4e8537`.
The pre-event interval is dominated by this CPU work, not admission or
corpus extraction. Individual Python warmup/embedding stages lack timers,
so do not claim an exact per-stage breakdown.

Preferred optimization to design and test: reuse embeddings for unchanged
passages, keyed by content and pinned model/configuration, keeping run-owned
authority and query-time scope checks. `retrievalPassageContext` currently
puts snapshotId and snapshotSha256 in embedded text; separating provenance
metadata from stable semantic text is necessary for cross-run reuse without
changing the input behind a cached vector. Add bounded stage timings/progress.
Lazy preparation could avoid unused work but would change the deliberate
mandatory-before-model contract in `docs/project-retrieval-haystack-only-2026-09-09.md`.
Do not silently disable hybrid retrieval or remove CSV coverage. The investigation
itself made no configuration change or deployment.

## Implementation in progress

The follow-up change stores validated float32 document embeddings in a bounded,
organisation/project-scoped disposable table in the existing product DB. The
input excludes run/snapshot identifiers and whole-file hashes; model and Python
runtime identities remain in the key. Haystack still reconstructs its in-memory
search store each run and embeds cache misses. The launcher reports cache hits,
computed vectors and preparation timings. Regression coverage includes a fresh
process, changed fragment, another project, corrupt vector and cache refusal.
Production latency improvement remains to be measured on a later Attica run.
