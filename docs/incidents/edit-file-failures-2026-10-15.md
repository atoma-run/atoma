# edit_file failures on the three Attica runs — measured 2026-10-15

Read-only reading of the production MCP: the three newest project runs,
all on the Attica property collector (`07864f7c`), L1 on `gpt-5.6-luna`.
Counts were parsed from the trace summaries and the failing calls read in
full. The baseline is [the 2026-10-11 measurement](edit-file-failures-2026-10-11.md).

## What was measured

| Run | status | write_file (failures) | edit_file | failures | rate |
|---|---|---|---|---|---|
| a62780e7 | cancelled | 2 (0) | 18 | 1 | 5.6 % |
| f74c140a | partial | 11 (0) | 112 | 9 | 8.0 % |
| 85cc4e83 | partial | 16 (0) | 180 | 17 | 9.4 % |
| total | | 29 (0) | 310 | 27 | 8.7 % |

The baseline was 14.3 % (171 of 1,198), led by the probe-manifest refusal.
That category is absent here: zero of 27.

| Category (the tool's own diagnosis) | Failures | Recovered on the next call |
|---|---|---|
| one region matches ignoring whitespace | 9 | 9 |
| the closest region diverges, or nothing resembles the span | 5 | 4 |
| several matches, no `replace_all` | 4 | 3 |
| double-escaped `old_string` | 3 | 3 |
| `old`/`new` sent instead of `old_string`/`new_string` | 3 | one turn, three parallel calls |
| empty `old_string` | 1 | moved on |
| displayed read envelope pasted as the span | 1 | after a re-read |

23 of the 27 failures are followed by a successful call; no streak exceeds
three calls, and the one streak of three is a single model turn that sent
three calls with aliased parameter names at once (9 ms apart), not three
retries ignoring the message.

## Why the whitespace family exists

Every whitespace failure sent a span with a leading space where the file's
top-level line has none (` const hosted=options.hosted??`,
` function snapshot(){…}`, ` active.configure({enabled:false});`), or a
French paragraph reflowed to another width. The files themselves explain
the recall error: functions, classes and whole test bodies are written on
one line, the one-space indent is used inside bodies and zero outside, and
the model reconstructs the span from memory rather than from a fresh read.

This style is not the model's default. The habit tracker's `server.js`
(ba826731, 2026-10-12, same model class) is conventionally formatted. The
Attica repository's `collect-listings.js`, written before these runs, is
already dense, and every later run matched what it found: a first dense
file sets the convention for the project.

The code change is `READABLE_SOURCE_RULE` ([src/atoms](../../src/atoms/AGENTS.md)):
runtime prompt text for every molecule that writes or edits a file, the
fallback executors, the proof turn and the recipe limits. It asks for one
statement per line and conventional indentation, kept even where the
repository is dense, with untouched lines left alone and minified or
generated assets exempt. It is not a mechanical gate: a density detector
would refuse a vendored minified asset or a data file, and every measured
failure here recovered in one retry.

## One tool gap, one occurrence

In f74c140a (event 588b3916) the molecule pasted the whole displayed
`read_file` presentation into `old_string`: the `read_file {"path":…}`
header, the `--- BEGIN FILE CONTENT ---` marker, the text, and the end
marker, then the same envelope plus its addition in `new_string`. The
tool answered "no region of the file resembles it", which was false: the
text between the markers was the file. `isReadResultEnvelope` recognises
the JSON `{path, content}` wrapper only, not the displayed form that
`formatToolResultContent` produces. Left open here; a named diagnosis
rather than automatic unwrapping is the consistent fix.

## The cost of the aliased parameters

The three `old`/`new` calls fell inside the CarbonDioxide execute call of
85cc4e83 that ended with "tool access was exhausted": 103 tool calls, six
failed `edit_file`s, and the HTTP probes and `validate_html` never ran, so
the phase's live routes stayed unverified. The alias refusal is an
intentional choice ([src/tools](../../src/tools/AGENTS.md)); its price in
this run was one model turn.
