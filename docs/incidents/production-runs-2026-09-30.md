# Production runs, 2026-09-30: an envelope read as prose, three README writers, a recipe Jev had refused

Four project runs on production (atoma.run), organisation "Matthieu Foillard's
organisation", all `depth: deep`, all on the host ChatGPT subscription
(`gpt-5.6-luna` / `terra` / `sol`), with Jev deciding in every run since
76e1c51. Each was read event by event from its trace; each defect was fixed at
its source before the next run.

| Run | Project, goal | Wall | Cost | Calls | Outcome |
|---|---|---|---|---|---|
| 8606cf38 | pomodoro page: a long-break mode | 890 s | $0.26 | 15 | delivered, two phases executed twice |
| 036ef18a | wordfreq CLI: `--min-length` | 486 s | $0.16 | 8 | delivered |
| 7265dd9b | guestbook: a `q` search parameter and box | 467 s | $0.17 | 9 | delivered |
| 0a989a58 | pomodoro page: keyboard shortcuts | 605 s | $0.15 | 10 | delivered |
| b9dc4d0b | pomodoro page: a focus-length select | 1,629 s | $0.46 | 21 | delivered after a root remediation, with a regression |
| 04ea696f | pomodoro page: the "Long break" line back | 667 s | $0.18 | 11 | delivered a page its verification phase replaced |
| cdc34023 | pomodoro page: the replaced page restored | 726 s | $0.22 | 7 | delivered, every criterion met, README carries verification residue |
| 0399bd82 | rerun of 04ea696f on 527b3b55 | 663 s | $0.20 | 7 | delivered the page with only its label changed |
| 1ed071e3 | pomodoro page: a tab title | 626 s | $0.19 | 7 | delivered; new README text clean, an earlier evidence section kept |
| 9854553c | wordfreq CLI: `--exclude` | 581 s | $0.19 | 10 | delivered; new README text clean, an earlier evidence section kept |
| fa8b6ce3 | wordfreq CLI: `--format csv` | 1,457 s | $0.44 | 17 | delivered; evidence section gone, README rewritten whole and three earlier runs' examples lost |
| c1d1b230 | pomodoro page: a B shortcut | 717 s | $0.22 | 11 | delivered; evidence section gone, one "verified" line kept |
| d99354c5 | wordfreq CLI: the README restored | 403 s | $0.09 | 5 | delivered; every flag's example and output and every error message back |

## A verified execution rejected as "non-JSON" (8606cf38)

The build phase's first execution passed every check, then pasted its
validate_html result, itself JSON, into `summary` with the quotes bare and the
newlines raw. Strict parse and jsonrepair both failed, the result became a
non-JSON fallback, the `non-json-envelope` gate rejected it, and the molecule
ran the phase again: 372 s spent twice. With the newlines escaped and only the
quotes bare, jsonrepair "succeeded" and cut the summary to 216 of its 1,387
characters, at the colon of `http:`.

Fixed in 6aa4ab6: `salvageResultEnvelope` reads such an envelope structurally,
only where every bare quote belongs to JSON the summary pasted. Its first
draft took the last `"}` on trust; an adversarial review fuzzed 20,000
envelopes and found it fusing a key after the summary, a second envelope or a
cut paste into 685 results the old path read correctly. The version that
shipped changes none of them and reads 1,518 that the old path refused or
misread.

## The README port, and who writes a README (8606cf38, 036ef18a, 7265dd9b)

The documentation phase wrote `http://localhost:43977/` into README.md, "the
static page entry point used for verification", and the review refused it: a
second execution. The static-web and HTTP molecules had carried the port rule
since 2026-09-26; the file scribe, which writes most documentation phases, had
not (de02d73). The next run gave its README to the project-docs molecule
instead, which had not either (e833eb3). The run after that, whose goal said
nothing about ports, documented `http://localhost:<port>/api/entries?q=hello`,
and 0a989a58's README wrote the placeholder too.

Both prompt changes reset the molecule's trust streak, as any behaviour patch
does, so the file scribe's next plans and results went through Jev: 036ef18a
recorded the first Jev approvals of a plan and a result on it, and the first
audit, where the model validator agreed with Jev ($0.005, 9.7 s, in the
background).

## A recipe Jev had refused, injected by the model (0a989a58)

Jev refused the verify-only `serve-and-validate-static-page` for a phase that
had to change the page (`changes_files` 0.16 against `task_changes_files`
0.97) and handed the pick to the model with the whole catalog; the model
injected that recipe, with "high" confidence. 8606cf38 had the same deferral
and the model chose the build recipe: across the 14 runs since the files
question exists, one of the two such deferrals went wrong. Fixed by
withholding every such recipe from the model's catalog, after an adversarial
review that also made Jev escalate itself when nothing left fits, see
[What the model is offered after a deferral](../jev-decisions-2026-09-28.md#what-the-model-is-offered-after-a-deferral-2026-09-30).

## A correct page refused on prose, and a regression shipped by the remediation (b9dc4d0b)

The first run on ff7242b shows the withhold working: both build phases read
"model decides (…; not offered: serve-and-validate-static-page)". The rest of
the run went wrong on words, not on code.

- The build phase's two reset probes asserted the requirement and passed
  (select 2700 → reset → `45:00`; select 900 → reset → `15:00`), but its
  summary said "reset restored 45:00 and 15:00 selections".
- The documentation phase turned that into a README sentence claiming the
  display returns to 45:00 while the select shows 15 minutes, "as observed
  during validation". Jev approved the phase, and so did both audits.
- Root acceptance refused the delivery: "Validation evidence shows reset
  restored 45:00 while the Focus select was 15 minutes". Its own input held the
  transport record of the 900 → `15:00` probe, which refutes that; the README
  was the only defect.
- The remediation re-planned both phases on that false diagnosis. It rewrote
  index.html whole (584 s, twelve validations), changed no reset logic, and
  changed the long-break mode line from `Long break` — the label run 8606cf38
  was asked for — to `Mode: Long Break`. No probe checked it, the acceptance
  passed, and the change is in the delivered repository.

Two more signals went unused in the first pass: two session-counter smokes
returned `ok:false` (their fixture set `select.value = '15'`, which matches no
option), no later probe proved that behaviour, and the summary said "session
counter checks passed"; the L2 validator approved. The last executed
observation was `ok:true`, so the validation ledger raised nothing, as
designed: it judges the document, not each claim.

Fixed in bc91e25b: a summary or document that states what was observed is a
claim too. The latest recorded observation of the file as it stands decides,
read against the task and in both directions. Values showing the requirement
met refuse the claim alone and say the artefact needs no change; values
showing a failure refuse the failure.

## A verification phase that replaced the page it verified (04ea696f)

The corrective run for b9dc4d0b's regression asked for one label back
("Long break") and nothing else. Its plan had two phases: the fix, declaring
`outputs: ["index.html"]`, and a "read-only verification" declaring none,
which the planning contract reserves for phases that change no file. The fix
phase changed the label. The verification phase's molecule opened with
`write_file` of a whole new index.html (4,700 bytes where the page had
5,863): another title, other labels, and a 25/45/60 focus select where the
page had 15/25/45. It verified its own page, was approved, and that page was
delivered and published (commit f73c0b0c).

Nothing enforced the contract. Across the 16 deep runs since 2026-09-24 there
were 36 root phases, and this was the only one without outputs. Among the
short runs' root-cell plans, the one subtask without outputs was f793b338's
"read-only inspect" (2026-09-27), and it overwrote the home page 23 times
without reading it. Both were damage.

The first fix refused `write_file` and `edit_file` in such a phase. Its
adversarial review broke it:

- a verifier that found a real defect was coached by the internal-validation
  gate to fix what the fence refused, and looped through its retries and a
  branch;
- the cell's fallback, which the fence did not reach, rewrote the page;
- `run_shell`, compiled scripts and a recipe's scratch file got past it too.

It was replaced before landing, at the owner's choice. The host now
photographs the workspace when a read-only phase starts and, when the phase
ends, restores every file the phase changed, whatever wrote it. It reports
the restoration to the phase's validator (`[READ-ONLY PHASE RESTORED …`) and
to the root acceptor. `.atoma-scratch/` is kept.

A second adversarial review found no way for a container to make the host
write outside the workspace: over 15,608 photograph-and-restore cycles, an
attacker kept swapping directories and files for links to an outside tree,
and the tree stayed byte-identical. The version that ships held the same way
over 29,264 cycles. The review did break what the restoration claimed, and
each break is closed:

- The verifier's page no longer shipped, but its proof did: a 375 px layout
  of its own rewrite still covered the criterion. What a restored execution
  observed now counts for no acceptance, and its probe manifest goes back
  with the rest.
- A server holding a SQLite database across the phase kept its own copy:
  the phase's rows shipped and another process's row was lost. SQLite files
  are now left as they are and reported.
- A photograph cut by its cap, a file it could not read, and a name that is
  not UTF-8 each hid a rewrite silently. Partial photographs are reported,
  unreadable files no longer blind the rest, and names are read as bytes.
- A phase that created 20,001 files starved the restore of the page. The
  restore now puts back what it photographed before it removes anything, on
  a separate budget.
- Routing split a one-phase plan into two phases, which marked the whole
  build read-only. Read-only is now decided on the phases the planner wrote.
- A read-only verifier that honestly reported a failure was rejected three
  times and coached to fix it. For a read-only task that failure is now a
  review finding, every validator is told the task is read-only, and the root
  acceptor reads every read-only phase.
- Restored work earned trust and skill credit. It no longer does.

A third review of those fixes found that some of them went too far or not far
enough:

- Every observation of a restored phase was discarded, so a verifier whose
  probes only made the server rewrite its data file lost its evidence and
  its credit. The runtime now tells DAMAGE (the phase's own writes put back)
  from a side effect of verifying. Only damage discards its evidence, puts
  back its probe records and stops the Node servers it started: a server
  restarted on code the restore put back went on answering from the undone
  version.
- Inside a tissue's read-only phase, the molecules were not marked, and the
  old rejection loop came back. The mark now reaches every task below the
  phase, and no recipe is distilled from one.
- A database that was empty at the photograph, an inode the filesystem reused
  for a new file, and a root or directory whose mode the phase changed each
  escaped. None does now.

A fourth pass found the damage test too narrow and too broad:

- It missed a rewrite through `sed -i`, a patched server entry, and a
  compiled script's writes. A path is now the phase's own when its writes,
  a server it started, a shell or probe command, or its script touched it.
- It read `.atoma-scratch/data.json` as the phase rewriting `data.json`.
  Relative paths now match exactly.
- The molecule that rewrote the page inside a tissue's phase kept its trust.
  Its own attested writes now withhold that trust.

What stays open: a phase that resets a data file to its original bytes and
then lets a probe change it counts as damage, which errs toward caution. A
server from an earlier phase that the phase only probed keeps what it holds
in memory.

- Contract: [src/atoms](../../src/atoms/AGENTS.md).
- Host half, which never follows a link a container made:
  [src/run](../../src/run/AGENTS.md).

## After the fix (cdc34023, 0399bd82)

Both runs ran on 527b3b55.

The repair, cdc34023, was asked for the page before 04ea696f replaced it,
criterion by criterion. It met all eleven: title, mode lines, button order,
the 15/25/45 select, the counter, the two shortcuts and the status line. It
also turned the dark theme into a light one, which no criterion named.

Its two phases both declared outputs, so nothing was restored. The existing
`write_file` guard refused a rewrite of the page before it was read, and the
molecule read it first. `search_project_docs` answered in 2.7 s.

The comparison rerun of 04ea696f, 0399bd82, had the same goal, the same
starting page and the same models. Its plan again ended in a read-only
review. This time that review read and inspected without writing. The
acceptor read "READ-ONLY PHASES — … changed nothing: …", and the delivered
page is b9dc4d0b's with only the label changed: 5863 → 5857 bytes, 99% of
its lines kept.

## Project search at its 2-second budget (7265dd9b, b9dc4d0b)

7265dd9b's only `search_project_docs` call returned `timed_out` after
2,005 ms, b9dc4d0b's after 2,007 ms; 036ef18a's succeeded in 1,860 ms. The
budget, `DEFAULT_PROJECT_RETRIEVAL_LIMITS`, came from the removed SQLite
backend, and a call that overran it killed the run's Haystack process, so
every later search in the run failed.

Fixed in ab93554a: the default budget is 10 s, and the run deadline still caps
each call. Registrations archived with the 2 s budget keep validating against
it; any other budget is refused as a changed setting. cdc34023's search took
2.7 s and answered.

## What a README leaves out (cdc34023)

cdc34023's README ends with a "Verification evidence" section: smoke values,
a SHA-256, line numbers and source quotes. Earlier READMEs of the same project
list observed values such as "`1499` seconds remaining". The evidence is
correct, but it was written for the validator, not for the person who opens
the README. The documentation prompts said which port a README must not name
and nothing of what else a document leaves out. The recipe that wrote most
of them, `write-verified-readme` (18 successes), says to write the document
"from that evidence" and to document "validation semantics".

Owner decision 2026-09-30: a delivered document is for its reader.
`READER_FACING_DOC_GUIDANCE` tells every molecule that writes documentation
that what a verification observed goes in its result's summary, never in a
README or doc, unless the task asks that document to record it. It reaches
the scribe and static guidance, the HTTP and full-stack prompts, and a cell
or tissue that executes its own plan with tools. The planners do not carry
it.

Its adversarial review found three places that taught the opposite, now
changed:

- The tissue's planning line said a documentation phase "reports evidence
  that already exists". It now points that phase at the recorded probes as
  its source, never as content for the document.
- The project-docs prompt said "cite exact original quotes, … source digests
  and line spans" without saying where. It now says in the result.
- Validation example 11 coached a wrong README sentence to be rewritten "from
  the recorded check". It now asks for what Clear does, with no observation
  note.

The review also found the first wording could be read as removing usage
examples, example output and exit codes. Those are behaviour, and the rule
says to state them as what the artefact does.

`write-verified-readme` and Glucose's `record-node-app-probes`, which records
"observed URLs, statuses, and outcomes" in documentation, are dropped once
the rule ships, so that the next documentation phase learns a new recipe
under it. A skill reset would not have been enough, since it keeps the body.

## The rule on its first runs (1ed071e3, 9854553c)

Both runs ran on f82ee3ad, after both recipes were dropped.

- 1ed071e3 added the tab title with one line in `render()` and changed
  nothing else. Benzene wrote a "Browser-tab title" section that states
  behaviour only. The digest, line numbers and observed values went into its
  summary, as the rule asks. Its `search_project_docs` call answered in
  3,985 ms, which the old 2-second budget would have cut off.
- 9854553c's `--exclude` works: case-insensitive, and an empty list or a
  missing value exits 1. We checked it by hand, combinations included.
  Ammonia documented it with examples and their exact output.

Both READMEs kept, as unrelated content, the evidence section an earlier run
had written, and in both it was now false:

- the pomodoro's cites the SHA-256 and line numbers of a page that no longer
  exists;
- the CLI's lists the probes of every flag but the new one.

The planner's documentation task said "preserve all unrelated README
content". The project-docs prompt says "Preserve unrelated content".

Owner decision 2026-10-01: a document a molecule edits loses the record an
earlier run left in it. What the document states as behaviour stays, and
"preserve unrelated content" does not cover such a record. The validator
prompt says the removal is never a reason to reject.

The accepted risk is that a measurement an earlier task asked the document
to record goes too: the "unless the task asks" clause only sees the current
task.

### The removal on its first runs (fa8b6ce3, c1d1b230)

Both runs ran on a5d66759, and in both the documentation molecule's prompt
carried the rule.

- **c1d1b230 (pomodoro).** Ammonia edited the README: the "Verification
  evidence" section went, and the new B shortcut was documented. The line
  "The verified static entry point is `http://localhost:<port>/` when served
  locally." stayed, because it sits in another section.
- **fa8b6ce3 (CLI).** The "Recorded CLI probe evidence" section went, but
  with it went content three earlier runs had asked for: the `--json`
  example and its output, and the exact outputs of `--min-length` and
  `--exclude`. The error messages were not restated either. The root planner
  had asked for it in so many words: "Update README.md through a full on-disk
  file write". It was reading the task constraint every build run carries,
  "The L1 worker must actually create the files on disk via the write_file
  tool", written in April against molecules that answered with code instead
  of writing it. The phase also matched the build recipe
  `build-text-frequency-cli`, whose step 4 reads "write_file … README with a
  real invocation and exact output", as 9854553c's had.

Fixed in de4a7f48:
- the constraint says write_file for a new file, edit_file to change an
  existing one;
- the rule says to remove what an earlier check left wherever it sits, a
  single "verified" line included.

Run d99354c5, on de4a7f48, restored the README with edit_file. It has an
example and its exact output for every flag, and a section stating each
error message with its exit status 1. All of them match the CLI byte for
byte, checked by hand over 6 commands and 21 error invocations. The usage
line printed without a file, and a combined example, are still missing.

Two adversarial reviews shaped the change:

- **The rule missed most molecules.** Stored prompts written before f82ee3ad
  never carried it, and Serotonin, which is trusted, wrote 1ed071e3's page
  from one of those. The rule is now runtime text: every molecule that can
  write a file reads it when it plans and when it executes, and no stored
  prompt carries a copy.
- **Its trigger was too wide.** It applies only when the task writes or
  updates a README or other doc, never a page, code or data file. A verifier
  that cleaned a README it was not asked to touch would be restored as damage.
- **Its conditions were too loose.** A record stays only when the task asks
  the document to keep or record it; an instruction to preserve unrelated
  content does not count. A document or section that exists to record results
  keeps its entries.
- **Its validator section was too narrow.** It now covers plans as well as
  results. It excludes usage examples, example output, exit codes and the
  entries of recording documents.

## Open

- **Earlier runs' requirements were not replayed.** The inherited
  `.atoma-probes.json` held smokes asserting `textContent === 'Long break'`,
  and nothing replayed inherited web entries. Owner decision 2026-10-01: the
  host replays them for a static page, at the start and at acceptance, and the
  acceptor decides ([design](../inherited-checks-replay-2026-10-01.md)). Most
  of this project's entries target hooks and ids the page no longer has, so
  only the checks that still passed when a run began are compared.
- **Molecules created before a prompt change keep the old prompt.** A
  canonical molecule takes each new prompt at bootstrap and loses its trust
  streak once. The other molecules keep theirs until
  `scripts/repair-atom-prompts.mjs --apply` runs on the host, and until then
  a run may create an equivalent molecule beside one of them. That covers the
  web template's `edit_file` step from 527b3b55 and the reader-facing rule.
- **Restored work inside a tissue's phase is still credited below it.** The
  molecules of a restored L3 phase are judged and credited by their cell
  before the phase ends, so only the cell's own trust is withheld.
- **Whole-file rewrites.** 0a989a58's web molecule regenerated index.html with
  `write_file` (a 104 s turn) where the prompt asks for `edit_file`. The task
  constraint of every build run said "via the write_file tool" until
  de4a7f48. Whether that was the cause here is not established.
- **A documentation phase matches a build recipe.** 9854553c and fa8b6ce3
  both injected `build-text-frequency-cli` into a README task. The model
  matched it as "the skill's CLI documentation workflow".
- **Identical full-stack molecules.** Five branches share CarbonDioxide's
  description and tools; Jev takes the canonical first ("first of 4
  identical"), so they cost catalogue space, not decisions.
