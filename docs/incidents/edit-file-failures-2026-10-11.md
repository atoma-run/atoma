# edit_file failures in production — measured 2026-10-11

Read-only reading of the production MCP: every project run created on or
after 2026-10-05, all organisations (140 runs, 104 with at least one
`edit_file` call; two had no trace). Counts for about 14 runs were parsed
from saved traces, the rest tallied by hand from the trace summaries, so a
run's call count may be off by one or two.

## What was measured

1,198 `edit_file` calls, 171 failures (14.3 % of calls), in 49 runs.

| Category (the tool's own diagnosis) | Failures | % of calls | Repeats in streaks |
|---|---|---|---|
| refuse to hand-edit `.atoma-probes.json` | 43 | 3.6 % | 15, 9 and 7 in a row (bad74240, 7f80148d, 76a9486c) |
| `old_string` not found, nothing resembles it | 38 | 3.2 % | 3 (22af997d) |
| double-escaped `old_string` | 38 | 3.2 % | — |
| the closest region diverges | 19 | 1.6 % | — |
| `old_string` is not a string (sent undefined) | 15 | 1.3 % | 4 (cb3843c6) |
| several matches, no `replace_all` | 11 | 0.9 % | — |
| one region matches ignoring whitespace | 6 | 0.5 % | — |
| tool budget exhausted | 1 | — | — |

The manifest refusal is the largest category and the only one that loops:
ten runs hit it, five of them more than twice.

## Why the manifest looped

The three shapes of the probe manifest had two machine recorders and one
hand: `record_probe` writes a shell entry, `fetch_url record:true` an HTTP
entry, and the web canonical prompt asked the molecule to `write_file` the
manifest itself after each browser check ("whenever you validated a page,
ALSO write_file .atoma-probes.json"). Read back from the recorded calls of
bad74240, 7f80148d and d029354b:

- the molecule wrote prose labels where a smoke belongs — `"smoke":
  "completion best update"`, `"persistence reload"` — then read the merged
  22 KB manifest back and tried to replace each label with a script through
  `edit_file`, in batches of four, refused four times, several minutes apart;
- the refusal told it to use `record_probe`, which the web molecules of
  those runs did not hold, or to `write_file` the whole document, which the
  existing-file rule in the same prompt forbids ("never write_file over a
  file the workspace already holds");
- the two runs with `record_probe` in scope (87d025f1, 9932c0b0) had no
  manifest refusal at all.

## What changed (2026-10-11)

- `validate_html` is the third recorder: a PASSING check, bound to the
  document it observed, is merged into the manifest by the tool itself
  (`appendWebProbe`, by the replay identity `webEntryIdentity`), with the
  interactions as sent and the viewport and waitMs only when the caller gave
  them. Only a check is recorded — real input, or a smoke that reads the page —
  and only a page bound to a workspace file; an unbound page (a Node server
  returning generated HTML) gets a warning. A host replay, a failing, refused
  or smoke-less call records nothing. The adversarial review before shipping
  added those two limits, the interactions as parsed, and dropped the old
  promise that an embedded UI records its server entry: it never could.
- `write_file` and `edit_file` refuse the manifest, both naming the recorder
  of each shape; the old pointer to `record_probe` and to a whole rewrite is
  gone. The web canonical no longer asks for a hand-written manifest, the
  existing-file rule says the file is never written by hand, and the runtime
  browser-proof lines say so to molecules whose stored prompt predates this.

Expected on the next runs: the 43 refusals and their streaks disappear; a
molecule that still tries, from a stored prompt, pays one refused call.

## Not addressed here

- The 38 double-escaped spans: the tool already hands back the exact bytes
  and auto-applies a literal token rename; the rest cost one call each.
- The 38 + 19 spans that do not exist: the model edits from memory after its
  own earlier edits; the tool returns the real region. 0a4a3e55 alone spent
  16 such calls on one test file.
- The 15 calls with no `old_string`: the argument shape the model sent is
  not in the summaries; to be read from the full events before deciding.
