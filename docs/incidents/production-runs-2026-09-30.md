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
| 41711050 | pomodoro page: an L shortcut | 614 s | $0.16 | 7 | delivered; first inherited-check replay in the container, nothing listed |
| 0b51e494 | pomodoro page: an S shortcut | 1,404 s | $0.33 | 16 | landed partial; the replay caught a regression twice and the remediation did not fix it |
| dadeea78 | wordfreq CLI: a usage line and a combined example | 157 s | $0.03 | 7 | delivered; README edited in place, the new example's output worked out and never run |
| 5dff35b0 | pomodoro page: the shortcuts repaired | 1,732 s | $0.43 | 23 | delivered and published a rewritten page the first acceptance had refused |
| 495c20ef | pomodoro page: restored after 5dff35b0 | 1,816 s | $0.51 | 18 | landed, refused twice, nothing published; 22 checks marked dead |
| c195ba35 | pomodoro page: four details fixed | 423 s | $0.13 | 8 | delivered and published; three edits, one listed check judged asked, approved first time |
| 81375f01 | pomodoro page: an F shortcut, after the prompt repair | 1,816 s | $0.51 | 36 | landed, unpublished; a planned test put hidden fields back, caught by an inherited check |

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

## A guard that swallowed every shortcut (0b51e494)

The goal added an S shortcut that starts or pauses the timer, "except while
focus is in a form control". The web molecule added the S branch, then
widened the keyboard guard from `input,select,textarea` to
`input,select,textarea,button`. Space, R, B, L and S then did nothing while
a button had focus, as one does right after a click on Start. Its cell
accepted the phase on the trust fast path (17 consecutive successes),
without a validation call.

- **The replay caught it, twice.** Of the 20 checks kept at the start, 18
  still passed on the delivery. Two failed twice: Space, then R, after a
  click on Start, and B after a click on Start. The acceptor judged both
  unasked and refused the delivery, the remediation's acceptance refused it
  again, and the run landed.
- **The remediation saw the steps without the space bar.** The listed steps
  read "click #start, keypress, keypress r": a key was printed only for a
  step without a selector, and a blank one vanished. The remediation
  molecule reproduced the failure, then wrote index.html back byte for byte.
  Steps now name the key (Space), and the text, value or file a step sends.
- **Two checks recorded in one write became one.** The molecule recorded a
  Space check and an S check that read one state smoke. Under a file+smoke
  identity, the S entry replaced the Space one in the same write, and the S
  check left asserts that S does nothing after a click on Start: the
  regression itself. Web identity is now what a replay runs (file,
  interactions, smoke, viewport, settle time), for the merge and the replay
  alike. The canonical web prompt's merge line says the same, which resets
  that molecule's trust streak once.
- **No check was marked dead.** The replay tried the 20 newest of its 40
  selected checks, all live, and its 60 s ran out before the older, dead
  ones. The first tool call came 37 s after it stopped. The replay now goes
  on while no tool call waits, up to 150 s.
- **A 75 KB read.** After writing the manifest, the web molecule read
  `.atoma-probes.json` back: 63 entries, 75 KB. Its next turn took 324 s,
  and the run's 14 luna calls read 723k input tokens. `write_file` answers a
  manifest write with the merged size, many times what the molecule sent,
  and nothing says why.
- **A recipe's whole-file step.** The injected recipe
  `patch-verified-static-ui` says "write_file <entry>, changing only the
  requested UI behavior". The first pass edited the page with `edit_file`;
  the remediation pass wrote index.html back whole, byte for byte.

## A README example nobody ran (dadeea78)

The goal added a usage line and one example combining three flags, "with its
exact output", to the CLI's README. The model's recipe matcher reused
`document-verified-shortcut`, a recipe learned while documenting a page's
shortcut; `build-text-frequency-cli` was offered and not picked. The file
scribe edited the README in place, twice, and kept every line it had. The
example's output is correct, but nothing ran it: the recipe says "Do not
rerun recorded behavior checks", and nothing had recorded this command. The
cell's validator accepted the output as "consistent with sample.txt", and the
root's reading-back did not reach it.

- **The recipe's step decided.** An injected llm recipe now carries two
  limits no step overrides. A file that exists is edited where a step says
  write_file, unless the subtask says to discard it or put an earlier
  version back. A "do not rerun" step never covers a new example. The
  adherence check shows the validator the same limits, so a molecule that
  obeys them keeps the recipe its credit.
- **The reader-facing rule says it once.** An example output a molecule adds
  is copied from a tool result of the run, never composed. A value that
  changes between runs shows as a placeholder, and an example nothing ran
  shows its command alone. Only the molecule's text changed: a validator
  still approves a worked-out output.
- **The manifest write says what it merged.** `write_file` on an existing
  manifest now answers with the entries sent and the total on disk. It says
  that earlier entries were kept beside the new ones, and that the file need
  not be read back, unless the merged manifest fails its check.

## A refused rewrite, approved on a replay that never ran (5dff35b0)

The goal repaired 0b51e494's regression: the shortcuts were to work again
while a button had focus, "Change nothing else". The run started from
0b51e494's landed page. Its start replay ran 83 s, 23 s past its budget,
until the first tool call waited; it kept 29 of 35 checks, and, the seed
having landed, it marked nothing.

- **Phase 1 fixed it.** The web molecule removed `button` from the guard
  with one edit_file and observed every shortcut working after a click on
  Start.
- **Phase 2 rewrote the page.** Its recipe, `serve-and-validate-static-page`,
  matched by the model for "browser-validate … and minimally repair", led a
  plan that said "First I will write_file the complete index.html source".
  The molecule did, without reading the page first, and both its plan and
  its result passed on the trust fast path. The page lost its countdown,
  Pause, the session counter and the mode line.
- **The first acceptance caught it.** Its replay listed 29 checks under one
  item, "index.html was REWRITTEN", and the acceptor judged it not asked for.
- **The second acceptance never looked.** The remediation worked on the
  rewritten page as if it were the page to keep. When it ended, about 90 s
  were left, and a replay needs 110 s to start a check: it replayed none.
  The block rendered empty, so the acceptor saw nothing about the 29 checks.
  It approved, although STARTING WORKSPACE said "REWRITTEN 4745 → 4558 bytes;
  47% of its starting lines remain". The run delivered and published it.
- **Now:** the acceptance after a remediation is refused unless its replay
  re-ran every kept check, and a replay that left checks unrun says so and
  forces the review. The recipe limits of edf54cb0 (an existing file is
  edited, not rewritten, unless the subtask says to discard it) were not yet
  deployed for this run.
- **Left in the project:** the published page is the rewrite. The next run
  starts from it, without a landing, so its start replay will mark dead the
  29 checks of the page as it was.

## The restoration, and an acceptor that read `asked` backwards (495c20ef)

The goal described the page in full, to undo 5dff35b0's rewrite. It ran on
5f5535d7.

- **The start replay reached every check.** It ran 109 s, past its 60 s
  budget while planning ran, and tried all 40 selected checks: 16 passed
  twice and 22 were marked dead, the old page's hooks being gone.
- **Edits, and no read-back.** The first phase's write_file over the
  unread page was refused, so it read the page and edited it. No molecule
  read the 100 KB manifest back; each write said what it merged.
- **The acceptor misread a check.** Two checks returned
  `{"mode":true,"remaining":true,"running":true,"status":false}`: the mode
  switched and the timer stopped, and only the restored page's test hook
  lacked `status`. The acceptor refused on "B/L leave the timer running".
  A changed value's detail now leads with the smoke's failed `checks`.
- **It read `asked` backwards twice.** One item's reason said the task
  redefines S, and its flag said `asked: false`; another flagged unasked the
  test inputs the restoration removed. A rewording that defined the CHANGE
  and named the cases of `asked: true` was replayed offline on the recorded
  root acceptance prompts, on luna:
  - 495c20ef: it matched the expected judgements less often than the
    wording in production, 74% of items against 95% (57% against 76% with
    production's own argument shape).
  - 5dff35b0, and a variant of it with a goal silent about the rest: both
    wordings refused every sample.

  The model judges whether the checked behaviour is required, not what
  changed, and it read failed `checks` as broken behaviour under both. The
  wording stays as it was.
- **A correction rewrote the page.** The remediation's second phase, with
  no recipe, wrote the page again whole. A runtime line already said that
  existing files are "edited, not replaced", and this trusted molecule's
  stored prompt still taught "write_file the complete source". The rule for
  a file that exists is now one definition, read at runtime by every
  molecule with edit_file and by the fallback executors, and it holds even
  where the molecule's instructions or a recipe say write_file.
- **The net held.** The remediation ran out of time and its acceptance
  replayed none of the 16 checks; the block said so, and the run landed,
  unpublished.

## Four details, edited in place (c195ba35)

The last run of the day fixed what 495c20ef left: the tab title, two
visible test fields, the sessions line's place and a README sentence. It
ran on c2ed5921, seeded from 495c20ef's landed page.

- **Edits only.** The web molecule changed index.html with three edit_file
  calls, each after a fresh read (6080 → 6242 → 5819 → 5799 bytes), and the
  README took one. Its stored prompt and its recipe still say
  `write_file`; the runtime rule won.
- **No read-back.** Its manifest write answered "102 entries already
  recorded were kept beside yours …; no need to read the file back", and it
  did not read the 113 KB file.
- **One listed check, judged right.** Of 8 checks kept at the start, 7
  still passed; the eighth lost the test field the task removed, and the
  acceptor judged it asked for and approved.
- **Published.** A browser drive of the published page confirmed the four
  fixes and every shortcut with a button focused. The project's main is
  whole again, two runs after 5dff35b0 published the rewrite.

## A test that put the fields back (81375f01)

The operator applied `scripts/repair-atom-prompts.mjs` at 08:28, which reset
every tier-1 and tier-2 trust streak. This run added an F shortcut on top.

- **No fast path.** Twelve validations went to a model and nine to Jev;
  no `trust` event appeared.
- **Edits only.** Every change to an existing file was an edit after a
  read. A manifest written empty kept its 105 entries.
- **12 checks marked dead.** The seed had been delivered.
- **The plan asked for a test the page could not take.** The tissue asked
  to prove F is ignored in a text field and a textarea; the page has
  neither. The web molecule added hidden ones to the page, undoing the
  run before, and Jev approved the result. The first acceptance's replay
  caught it: c195ba35's own "no test fields" check failed on three
  entries, and the acceptor judged them regressions.
- **Then the clock.** The remediation removed the fields. The tissue then
  refused it on a probe that a later passing one had superseded. A
  full-stack branch added an unrequested `server.js`, and a README check
  was refused falsely. The last acceptance's replay was aborted by the
  deadline, and the run landed (fail-closed).
- **The repair missed a marker.** The script had no branch for the
  project-docs molecule. It gave it a generic prompt, and the next
  bootstrap put the canonical one back, two versions later.
- **Now:** a molecule that validates a page creates a test-only control in
  its smoke and removes it before returning, never in the page; and the
  repair script uses the bootstrap's own project-docs prompt.

## Open

- **Earlier runs' requirements were not replayed.** The inherited
  `.atoma-probes.json` held smokes asserting `textContent === 'Long break'`,
  and nothing replayed inherited web entries. Owner decision 2026-10-01: the
  host replays them for a static page, at the start and at acceptance, and the
  acceptor decides ([design](../inherited-checks-replay-2026-10-01.md),
  a697acaa). Most of this project's entries target hooks and ids the page no
  longer has, so only the checks that still passed when a run began are
  compared. Its first production run, 41711050, ran in the worker container
  on Debian's chromium:
  - **At the start:** of 40 checks selected, the 60 s budget reached 27, and
    17 passed twice, in 45 calls. The replay overlapped the planning; the
    first molecule tool call came about 9 s after it ended.
  - **At acceptance:** all 17 still passed, in 17 calls, and nothing was
    listed.
  - **Clarity fix:** the log said "17 of 40" and the record "27 considered".
    Both now name the selected, tried and kept counts.
  - **Dead checks:** ten of its 27 start replays went to checks whose hooks
    were gone. A check whose two start replays both lost a hook or an
    element, with no refused request and no page error, is now marked in the
    run's manifest; a later run that finds it dead again removes it beside a
    check of its page that passed. A changed value is never dead, and a run
    seeded from a landed one marks nothing (7259e099,
    [design, Known limits](../inherited-checks-replay-2026-10-01.md#known-limits)).
  - **Container arm:** the Docker job now replays in the host mode on the
    worker image's chromium, with a WebSocket to another container port
    that a molecule's call reaches and the dead proxy refuses.
- **Recipes that rewrite a file whole.** `build-text-frequency-cli`
  (README) and `patch-verified-static-ui` (index.html) both carry a
  `write_file` step for a file that exists. The injected block now limits
  such a step; distillation still writes it.
- **Manifest read-backs.** A manifest that grows by every run's checks costs
  every molecule that reads it back (75 KB in 0b51e494). The merge's answer
  now says why the file is larger; nothing else stops the read.
- **An unobserved example output is approved.** The rule reaches the
  molecule only; no validator asks where an example's output came from.
- **A landing keeps an unaccepted phase's bytes.** 495c20ef's second
  remediation phase ran 495 s and was cut; its page stayed in the
  workspace, which the next run starts from, while the result's evidence
  named the previous one.
- **Checks bound to a test hook's shape.** Each rewrite of this page exposed
  a different `window.__test`, so its checks cannot pass on any other
  version; restoring the page fails them all, and the acceptor reads those
  failures as broken behaviour (offline replay of 495c20ef, both wordings).
- **`asked` read as "is this behaviour required".** The acceptor judges the
  check's expectation, not the change; no wording tried moved it.
- **A landed run's listed checks.** 0b51e494 landed with two listed checks.
  The next run starts from its page, where both fail at the start, so they
  are not kept and never compared: only the landing reasons carry them.
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
  matched it as "the skill's CLI documentation workflow". The recipe matcher
  now reads that a recipe which builds an artefact (writes or rewrites its
  code) does not fit a task that only documents or only verifies one. The
  file scribe's first step now says `write_file` is for a new file and
  `edit_file` changes one that exists; that canonical prompt change resets
  its trust streak once. Both runs were the model's pick, which this covers.
  Jev answers before the model, and its files question cannot tell a README
  edit from a build, so a recipe Jev picks is not covered (7259e099).
- **Identical full-stack molecules.** Five branches share CarbonDioxide's
  description and tools; Jev takes the canonical first ("first of 4
  identical"), so they cost catalogue space, not decisions.
