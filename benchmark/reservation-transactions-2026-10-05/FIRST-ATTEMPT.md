# First attempt: provider failure before implementation

Run 4b7cc920-e94d-4922-8df3-233b4ed21bbd on production 628826cf failed after
234.239 seconds. All 24 events and complete metadata/log pages are archived in
first-attempt.json.gz. Five LLM calls recorded $0.11334744 subscription-equivalent
usage, not a cash invoice. The only tool was list_files, returning an empty
workspace. There was no code write, functional test, artifact or publication.

The execution call ended after 121172 ms with `codex call failed [provider-error]`.
Neither the full event, metadata nor runner log exposes a more specific cause.
The transport intentionally reduces provider prose to a safe failure vocabulary;
the duration alone does not prove a timeout or a product defect. No model switch,
timeout increase or transport patch is justified by this record.

## Explicit protocol addition before retry

One separate second attempt uses the same project, goal, criteria, depth and
model defaults, with a new idempotency key only (retry-request.json). There is no
successful/partial predecessor to seed. This is an operational retry after a
pre-implementation failure, not a controlled repeatability estimate. Preserve
and count both attempts; do not relabel the first as a success. The frozen oracle
and its labels remain unchanged. If the same failure recurs, investigate the
transport before spending another run.
