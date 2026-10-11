---
name: project-search-timeout
description: "RESOLVED 2026-09-30 by ab93554a: search_project_docs default budget 10 s (was the 2 s SQLite-era budget that timed out Haystack in prod); archived registrations keep validating against 2 s"
metadata:
  node_type: memory
  type: project
  originSessionId: e82e9669-4aba-430d-ba86-145d0c444324
  modified: 2026-09-30T19:12:39.965Z
---

Resolved by ab93554a (2026-09-30, "give a document search the time Haystack takes"): the default
`DEFAULT_PROJECT_RETRIEVAL_LIMITS` budget is 10 s and the run deadline still caps each call.
Registrations archived with `timeoutMs: 2000` keep validating against it; any other budget is
refused as a changed setting. First run after it: cdc34023's search answered in 2.7 s, which the
old budget would have killed.

The original symptom: 7265dd9b's only `search_project_docs` call timed out after 2005 ms and
b9dc4d0b's after 2007 ms. A timeout SIGKILLs the run's Haystack child, so every later search in
that run failed too. Recorded in docs/incidents/production-runs-2026-09-30.md.

**Why:** search is mandatory in every project run (owner decision 2026-09-09) and silently useless
when it times out.
**How to apply:** if searches time out again, compare the latency against 10 s before touching the
budget. Changing the default again means handling the archived registrations the same way.
Related: [[jev-decisions-state]].
