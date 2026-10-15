# Production runs, third day: a restored store refilled by its own server — 2026-09-28

Three runs on the `atoma-stress-20260927` project (org `mgtf2`), each
continuing the previous delivery of the Team notes app, depth `deep`, on the
production revision of the day (5707c5a, then a670fae). All three were
delivered. The deliverables were probed through the result preview, not only
through the run's own acceptance.

| run | goal | duration | cost | outcome |
|---|---|---|---|---|
| R4 `1eafec70` | tags (validated), `?tag=&q=` filters, `GET /api/tags` | 11 min | $0.25 | delivered; every API criterion held under probing |
| R5 `7761081b` | responsive widths, theme switch, keyboard use | 24 min | $0.48 | delivered; works, left dead files |
| R6 `ed84d7be` | CSV export and import, remove unused files | 27 min | $0.66 | delivered after one root remediation; two defects shipped |
| R7 `c8783210` | fix R6: unique ids on import, drop the duplicate page, empty store | 11 min | $0.27 | delivered; all three hold under probing |

## What held

- R4: tags outside the rule (uppercase, 21 characters, a sixth tag, a string,
  a space, an empty word) are refused with 400 and one JSON error, on create
  and on update; `tag` and `q` combine and `q` is case-insensitive over title
  and body; `/api/tags` sorts by count, then name.
- R6's root acceptance REFUSED the first delivery ("unused app.js and
  styles.css remain despite the explicit cleanup requirement"), a root
  remediation removed them, and the second acceptance approved: the
  cleanup criterion worked as a criterion.
- The preview claim flow works from a non-browser client (`POST
  /.atoma/claim` with the fragment), and a preview nobody heartbeats closes
  at the 15-minute idle bound, which bounds how long it can hold a
  deployment.

## What shipped wrong

1. **A restored data store, refilled by the server holding it.** R6's worker
   restored `notes.json` to `[]` (the run's starting content) at 04:18:26,
   as its prompt asks (`src/atoms/L1Atom.ts`, "a data file your probes
   filled goes back to what it held before your checks"). The app's server
   was still running with the probe notes in memory; the worker's next
   probes (an invalid import, a round trip) made the SERVER rewrite the file,
   and the delivery carries 403 bytes of probe notes. The rule is a prompt
   rule, and the process that owns the data undoes it. The host knows which
   file changes came from the worker's own file tools; a change it cannot
   attribute to one — made by a process the worker started — is a fact the
   acceptor is not shown today.
2. **Import duplicates ids.** `POST /api/notes/import` keeps an imported
   `id` even when a note already has it, so export then import of the same
   store yields every note twice under one id (`rt-1` twice in the probe
   data above); update and delete by id become ambiguous. The goal made `id`
   optional and said nothing of collisions, so no criterion caught it.
3. **A duplicate page nobody serves.** R5 wrote the page twice, `index.html`
   and `public/index.html`; the server serves the first and `/public/` is a
   404. R6 edited both separately (9 684 and 9 803 bytes) and its cleanup
   pass kept the unserved one, although the task asked for unused files to
   be removed.

## After c0e0c99

The molecule is now told to restore a filled store AFTER its last request
that changes data (c0e0c99, deployed 04:37). R7, the first run on it,
delivered `notes.json` as `[]`, but that is NOT evidence for the rule: its
worker again wrote `[]` (04:51:43) and then sent one more import, which the
server refused with 400 and so wrote nothing. Had that last import been
valid, the server would have written its in-memory notes back, exactly as
in R6. The prompt rule alone is weak; the fact in item 1 is what would make
the acceptor see it. R7's import now gives a fresh id to a row whose id is
already used or repeats within the file, and `public/index.html` is gone
(404).

## A retired host model, a minute into every run

R8 (`d019cfe8`, the admin organisation's first run of the day) failed in 65
s with `codex call failed [request-rejected]`: its account pinned
`sub:openai:gpt-5.4-mini` on L1, and all three calls to it were rejected
while the `gpt-5.6-terra` planner in between was served. The same slug had
failed the same way on a personal login on 2026-09-21
([mgf2-production-run-2026-09-21.md](mgf2-production-run-2026-09-21.md)),
whose model list has since been discovered from Codex; the host's list is
still static and still offered it, as its SMALL default too. Re-pinned to
Terra, the same goal delivered in 4 min 26 (`9f5681c9`). The host list now
offers Luna instead, and a stored Mini pin is refused before spending.

## For the supervisor

None of the three produced a mend: from R4's end (03:02 UTC) to after R6's
analysis (04:26) the mender never took the run slot, and the analyst held it
about 30 to 100 seconds per run. Whether its verdicts named any of this could not be read
from the operator account used here (no platform tier on its MCP token, no
read access to `supervisor/`). Item 1 is a `mechanism_candidate`: its remedy
is a choice about which fact to show the acceptor.

Why the mender had never opened a pull request at all is its own record:
[mender-never-opened-2026-09-28.md](mender-never-opened-2026-09-28.md).
