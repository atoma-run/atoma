# Why the first delivery is refused — every production run, 2026-09-20 → 2026-10-10

Read-only measurement on the production MCP, 2026-10-10: every project run of
every organisation (97 projects, 310 runs) and the operator corpus (6 traces).
No run was started for it.

## What was measured

| | Runs |
|---|---|
| Runs collected | 316 |
| Runs that reached root acceptance | 275 |
| First root acceptance refused | **118 (43 %)** |
| — approved after the remediation pass | 43 |
| — refused again (landed `partial`) | 75 |

Wall time after a first refusal: 38,432 s of the 169,215 s these 275 runs
took (22.7 %). The refusal rate rose with the user-approved lists the
campaigns of October used: 9 of 58 drafted lists against 105 of 209 user
lists were refused first.

## Classification of the 118 first refusals

Each first refusal's reasoning and per-criterion judgements were read and put
in ONE category by its main cause. One reader, no second rater: a category is
a judgement about the acceptor's prose, not about the delivered bytes.

| Category | What the acceptor said | Runs | Rescued |
|---|---|---|---|
| E1 | a browser journey a criterion names was never exercised: reload, keyboard only, a width, a before/after state | 34 | 12 |
| E2 | a test-side clause had no visible executed assertion, or the tests were not run after the last edit | 26 | 12 |
| E3 | the evidence the acceptor read was cut (test body, page, read-back) | 8 | 1 |
| E4 | no renderer to inspect a visual deliverable | 1 | 0 |
| D | a real defect: regression, wrong content, a stated requirement violated | 32 | 12 |
| I | the pass itself was incomplete: phase never ran, dependency or server unavailable | 11 | 2 |
| R | the report contradicted the recorded probes | 3 | 3 |
| M | the criteria review returned incomplete judgements, no defect named | 3 | 1 |

- E1: 068cfe14 0e6db012 1664f654 1826a019 2f63b887 32f052d8 34da7f81 4d3aafa3 50be47bf 7389feee 75376521 779d854c 7aeda810 7b49d757 7f80148d 80f94d90 9932c0b0 9988c8c3 a1216918 bad74240 bf5ea48f d029354b d14bddbc d7179253 d7aad8af dfa20873 dfcf98ca e8c9dee8 e957af55 ebaac7bc ebc60ee4 f33379a4 f5404631 fc920c31
- E2: 0a4a3e55 2c03a3f6 2c502876 430b429e 43682d38 442da084 4c1a1e8c 66bf4b67 6a8b44c7 6c582953 715ffc74 7a247d71 7ec68ae1 81134e57 81b4f850 842ceba8 87d025f1 8d819d66 9fa66b4a a05c004c b17772fc b38cb8da b873c5a2 bdbe080c d0c4ad08 e6655476
- E3: 16a8232a 25142c72 2faac5cb 41e069a6 834ed524 cb53b09d df23bda8 f0a51beb
- E4: 288d04d1
- D: 0b51e494 12cf7e36 130f7b7e 19b740fe 318b210a 36606853 396c02ed 495c20ef 544d5a62 5a5f1e27 5dff35b0 5e44975b 64d5478e 6ab0ae3b 7888eed7 81375f01 822bb4fe 8fc39475 96d5c845 97c607e0 b9dc4d0b bcf35298 c8c67a68 ca745b4b cc7ed6f1 cc922a60 cf0ab5ec ed84d7be f1ddf0b7 f793b338 fc2a68cf ff1d2006
- I: 02d740a1 113ed33f 18aec51a 1d42ac2a 671da856 69f6f608 7f7aec0b 87e672d7 c949f7e7 d3f465ac ecb7cf16
- R: 270e834c 72e81903 947a21a2
- M: 299627a9 9bcf5514 cb3843c6

## The mechanism behind E1 and E2

The checklist reached the ROOT planner (`inputs.acceptanceChecklist`) and the
root acceptor, and nothing in between: `taskContextLines` deleted it from
every delegated phase since 2026-10-02 so a phase would not be judged on the
whole root list. The molecule that wrote a check therefore read its phase
description — "verify favourites with the keyboard" — and never the
criterion — "keyboard only, with no mouse". Its validator approved the phase
on the same description. The root acceptor was the first actor to hold the
evidence against the criterion's words, and a refusal there costs a full
replan (a top-tier plan, a new cell, a new molecule). The remediation pass
rescued about a third of these refusals.

## What changed

`Task.criteria` carries the criteria a phase records evidence for, in the
acceptor's words. The host sets the run's list on the root task; a plan's
subtask names the ids it proves (`"criteria": ["c2"]`) and `delegatedCriteria`
hands each child its own. Delegated planners, executors and validators read
them through `taskContextLines`; the root planner keeps reading the whole list
through its inputs. A user criterion assigned to a phase is that phase's
requirement; a drafted one informs it and adds nothing the goal does not
state. A remediation pass carries only the criteria the acceptor did not judge
met.

The adversarial review of the change (2026-10-10, before it shipped) narrowed
three things:

- An id no subtask names reaches the last phase of a SEQUENTIAL plan (or a
  plan's only subtask) as CONTEXT, never as its requirement: a README phase
  judged on a keyboard criterion would loop. Parallel lanes have no last one
  and get none.
- A compiled script's dispatch is judged without the criteria: it never read
  them, and a refusal there counts against the script.
- The binding line asks for an executed check whose assertion observes each
  part, not one "in this phase", so standing host evidence still counts.

Kept as they are: criteria on a reasoning subtask (text deliveries have
text criteria: "answer every one explicitly"); the Jev calibration replay
folding the new lines into the task description (they stay visible in the
replay rather than being dropped); the molecule planner of a whole-task
shortcut reading both the root list and its criteria (a few hundred tokens,
and the shortcut contract pinned by `tests/reasoning-delivery.test.ts`).

The 2026-10-02 rule still holds: no phase is judged on the whole root list,
only on the criteria its plan gave it.

## E3: evidence cut by the read-back

Four of the eight showed a test's title line and not its assertions: past a
long file's head, `criteriaFilesBlock` kept up to 15 ISOLATED lines holding a
criterion word, and the word sits on the title. One (cb53b09d) cited fixture
files nobody read; three cut a long page or calendar before the part judged.
Seven of the eight came after the 2026-10-05 read-back fixes. Since
2026-10-10 the reader keeps the block each such line opens (its
deeper-indented lines and closer), no longer matches "test" or "spec" (on
every title of a test file), and reads the small files a test script names in
a string literal. Its adversarial review, before it shipped, capped one block
at a quarter of the block budget (an early `describe()` starved the rest),
gave the head back what the blocks left unused without overlapping them,
counted line offsets on CRLF files, and limited references to test scripts,
outside `package.json`. The long-page cases are not addressed: their judged
part may sit anywhere.

## Not addressed here

- False approvals the collection surfaced in the opposite direction:
  2b0f701b, c343e664 and 8d3a16a0 approved a wrong stanza audit; d162ee31
  approved a result that said its probes were not run; 7761081b judged a
  reload criterion met on an errored reload check. Not yet analysed.
- The prediction is that E1 and E2 first refusals fall on the next campaign.
  Today's tool fixes (`reload`, typing at focus, focus/activation pairs) also
  target E1, so a fall cannot be credited to this change alone.
