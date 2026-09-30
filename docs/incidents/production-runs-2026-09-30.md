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

## Open

- **Earlier runs' requirements are not replayed.** The inherited
  `.atoma-probes.json` held smokes asserting `textContent === 'Long break'`;
  nothing replays inherited web entries at acceptance, so a regression of an
  earlier run's requirement ships unless the current run happens to test it.
- **A document's claim about what was observed decides a verdict.** The root
  validator took a README sentence over the transport record in its own input.
  The validator prompt says self-reported success is not evidence; it says
  nothing of a claimed observation in the other direction.
- **Project search times out at its 2-second budget.** 7265dd9b's only
  `search_project_docs` call returned `timed_out` after 2,005 ms, b9dc4d0b's
  after 2,007 ms; 036ef18a's succeeded in 1,860 ms. The budget is `DEFAULT_PROJECT_RETRIEVAL_LIMITS`,
  inherited from the SQLite backend, and a call that overruns it kills the
  run's Haystack process, so every later search in the run fails. Raising it
  touches every archived retrieval registration, which records `timeoutMs:
  2000` and is validated against the current default. It needs a measurement
  of where the time goes on the host (the hybrid reranker is the likely part)
  before a number is chosen.
- **The repository holds 04ea696f's replaced page** (commit f73c0b0c). A
  repair run goes after the restoration deploys.
- **Restored work inside a tissue's phase is still credited below it.** The
  molecules of a restored L3 phase are judged and credited by their cell
  before the phase ends, so only the cell's own trust is withheld.
- **Whole-file rewrites.** 0a989a58's web molecule regenerated index.html with
  `write_file` (a 104 s turn) where the prompt asks for `edit_file`.
- **Identical full-stack molecules.** Five branches share CarbonDioxide's
  description and tools; Jev takes the canonical first ("first of 4
  identical"), so they cost catalogue space, not decisions.
