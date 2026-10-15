---
name: edit-file-manifest-2026-10-11
description: "edit_file failure measurement (140 prod runs, 171/1198 failures) and the structural fix 4cf75d87 — no model writes .atoma-probes.json, validate_html records its own passing checks"
metadata:
  node_type: memory
  type: project
  originSessionId: 7f8e1401-022c-4c27-80f8-737bb447be7a
  modified: 2026-10-11T03:20:27.728Z
---

2026-10-11, owner asked to fix edit_file failures "once and for all". Measured on all 140 project runs since 2026-10-05 (counts in session scratchpad/editfail/counts.json): 1,198 edit_file calls, 171 failures (14.3 %): probes-json refusal 43 (the ONLY looping category: streaks of 15/9/7), not-found 38, double-escape 38, diverges 19, old_string undefined 15, multi-match 11, whitespace 6.

Root cause of the loop: the web canonical told molecules to write_file the manifest by hand; they wrote prose labels as smokes, then "repaired" them with edit_file; the refusal pointed at record_probe (web molecules don't hold it) or a whole rewrite (forbidden by the existing-file rule in the same prompt).

Fix 4cf75d87: validate_html = third recorder (appendWebProbe by webEntryIdentity; only a check — interactions or a page-reading smoke — bound to a workspace file; host replay/failing/unbound → nothing, unbound gets a warning); write_file AND edit_file refuse the manifest (`manifestHandWriteRefusal`); canonical + EXISTING_FILE_RULE + runtime browserProofLines updated. Adversarial review applied. Record: records/incidents/edit-file-failures-2026-10-11.md.

Known limits: document binding fails on this Windows machine (tests/document-binding and my recording tests skip/fail locally; CI Linux is the gate). Stored web prompts still say "ALSO write_file" → one refused call each until repaired.

Open: the other 128 failures are single wasted calls with diagnostics (double-escape, memory-edited spans); 15 calls sent no old_string (arg shape unknown, read full events before deciding); 0a4a3e55 spent 16 not-found on one test file.

**How to apply:** when a molecule loops on a refusal, check first whether the message names a tool it holds. See [[first-refusals-2026-10-10]].

2026-10-13 follow-up: 19 project runs on Oct 12–13, 462 edits, 60 failures,
no manifest refusals. Six not-found calls passed exactly JSON.stringify of
the preceding read result (including path/content), with unchanged content.
Eight omitted old_string (six path/new_string, two old/new aliases); the
remaining cases were escaping, inexact/ambiguous spans and one empty span.
Implemented one model-facing file-text formatter across all seven transport
loops, preserving raw structured observations and paging metadata, plus
specific non-mutating edit argument/wrapper diagnostics. Never automatically
unwrap or unescape replacement arguments. Details and production event IDs:
`records/incidents/edit-file-failures-2026-10-13.md`. Production benefit remains
unmeasured; mocked transport regressions establish the byte contract.
