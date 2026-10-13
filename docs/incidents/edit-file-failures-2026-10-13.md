# File reads presented as JSON became edit arguments — 2026-10-13

## Production evidence

Read through the production MCP, without starting any run. The window is
the 19 project runs started on October 12–13, ending with `c161334a` at
07:22:47 UTC on October 13. Project listings and event summaries were paged
to their ends; all 60 failed edit events were read in full, with surrounding
reads and successful corrections for the envelope cases.

There were 462 `edit_file` calls, 60 failures (13.0%), across 11 runs.
They account for 60 of the 63 tool errors in this window. Categories are
mutually exclusive; envelope copies are split out of the not-found category:

- 18 extra escape layers in `old_string`.
- 11 spans beginning correctly and then diverging from the file.
- 9 absent spans, excluding envelope copies.
- 8 missing `old_string`: six calls sent only path/new_string, two sent
  path/old/new.
- 6 complete serialized `read_file` results passed as `old_string`.
- 5 ambiguous matches (including `render();` and `});`).
- 2 whitespace mismatches.
- 1 empty `old_string` used to write an empty file.

Per-run edit calls / failures, identified by unique production run prefix:

- `c161334a`: 0 / 0; `6782ce92`: 14 / 2; `6451ea1d`: 0 / 0.
- `8a38383c`: 31 / 3; `e3687ac7`: 33 / 3; `26b14f2f`: 42 / 6.
- `351b224a`: 85 / 13; `b5077432`: 139 / 16; `9e69b923`: 0 / 0.
- `c092b5d6`: 52 / 6; `f01c3bd0`: 0 / 0; `3069ac59`: 24 / 7.
- `025de5b9`: 5 / 1; `4e5c5c4b`: 0 / 0; `ba826731`: 6 / 2.
- `f5d0fded`: 4 / 0; `81b998a0`: 7 / 1; `4f615a5d`: 11 / 0.
- `fb84de15`: 9 / 0.

No manifest edit refusal appeared in this window. The earlier October 11
reading-log runs still show the old refusal and are excluded from these
counts. This is not a controlled before/after model comparison.

## Confirmed mechanism

`read_file` returns `{path, content}`. Transports serialized that object as
the model-facing text. In all six envelope failures, the supplied old span
was **exactly JSON.stringify(the immediately preceding read result)**; its
decoded content was still exactly the file. The generic diagnostic blaming
a wrong file or changed content was misleading.

The six error events:

- Run `26b14f2f-411d-4327-9965-f66d5ac59dfb`, event
  `ecdcc474-e2a0-48d3-98fb-e620d628ec80`, `tests/collect-listings.test.js`.
  Read `24d256b1-aa5e-4603-93b5-7f79b9e973b6`; later edit
  `8ca991ac-0c74-433d-a529-05bf8a4f75b3` succeeds with file text only.
- Run `b5077432-aa14-43c6-b04f-c9a155336c6b`, events
  `0677a54b-e274-4ee9-ab3c-b41b5e681313` and
  `7f8d88f2-20d4-4d1e-907f-f287c56daec8`, `report.md`.
- Run `c092b5d6-554f-4214-9dcd-b91e664e2dcc`, events
  `af811aba-a786-476b-8007-b6f2e0b64d48` (`collect-listings.js`) and
  `83aa54d0-682d-447c-afbc-b9b559584e00` (`report.md`).
- Run `81b998a0-d996-4456-8891-8d65c7ceb3b7`, event
  `4d896e94-ff27-44f9-8910-c44ea3f08edb`, `app.js`.

The calls arrived 3–11 ms after the preceding read began, consistent with
programmatic forwarding of the result. The trace does not retain the
provider's intermediate program, so the expression that forwarded it is
unknown. In particular, the six missing old spans are not proof of any
specific `.content` accessor mistake.

## Change and adversarial review

All seven transport loops now use one `formatToolResultContent` function.
Only model-facing `read_file` results with a string content field change:
the body is verbatim inside markers and metadata stays outside. Markers
are chosen to be absent from the file. Large reads retain the existing
explicit head/tail elision, bounded with room for framing. Page offsets,
nextOffset and totalChars are preserved. Observers, traces, attestations
and host readers keep the complete structured object; missing paths and
directories remain their structured answers.

`edit_file` diagnoses a serialized read result only on a failed exact match
and only when the wrapper's path and content match the current file.
It applies no edit. Missing/wrong-type arguments name the required fields;
old/new aliases are explained but never translated automatically.

Adversarial cases checked against the accepted design:

- Literal JSON files containing path/content must still edit normally;
  exact matching happens before wrapper diagnosis.
- A stale wrapper or one naming another path must not claim a current match.
- New replacement escapes must never be inferred from the old span.
  Existing double-escape and nearest-span regressions remain in force.
- Empty files, literal backslashes, Unicode, NUL, absent/present final
  newlines and file text containing the display markers retain their bytes.
- Page metadata and truncation markers remain visible; framing is not source.
- Missing new_string is not deletion; an explicit empty string still is.
- Native Codex JSON-RPC, the exec fallback and the Anthropic transcript
  retain the raw observed result while presenting the separate text body.

These are mocked transport and real-tool regression checks, not a paid LLM
replay. A reduction in production error rate remains to be measured. This
change does not make absent or ambiguous spans executable, and does not
claim that all 60 failures would disappear.

The first CI static job caught a compiled retrieval smoke whose fake model
JSON-parsed every tool result, including the newly displayed file text.
The smoke now checks file presentation explicitly and still parses and
asserts the retrieval/shell results. The production change remained behind
the failed CI deployment gate while this fixture was corrected.
