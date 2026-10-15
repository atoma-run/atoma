---
name: decision-naming
description: "Reader-facing name of TypeSafe's Jev model is \"Decision\" (FR \"Décision\"); code, env vars, MCP tool, trace kinds keep `jev`"
metadata:
  node_type: memory
  type: project
  originSessionId: 5222d722-b449-4a3b-bdde-fb56421aee58
  modified: 2026-10-15T08:20:32.106Z
---

Owner decision 2026-10-15: everything people read calls the bounded-decision model **Decision** ("Décision" in French) — UI copy (`en.json`), README, docs, AGENTS files, memory, MCP descriptions, log lines — because deciding is what it does. Where the vendor product is named, write "Decision, TypeSafe's Jev model".

Deliberately unchanged (owner chose the reader-facing scope only): TS identifiers and file names (`src/core/jev.ts`, `JevDecider`…), `ATOMA_JEV*`, `atoma_jev_calibrate`, trace `kind: 'jev'`, the cost slice key `jev`, i18n keys, the vendor model id `jev-1.13.0`, doc file names (`jev-decisions-2026-09-28.md`), `records/` and `benchmark/` archives, and owner quotes cited verbatim.

**Why:** "Jev" says nothing to a reader; renaming wire contracts would break the prod env, registered MCP clients and stored traces.
**How to apply:** new prose says Decision; never introduce "Jev" as a product name in reader-facing text. Avoid "Decision decision" — write "Decision answer(s)". See [[jev-decisions-state]].
