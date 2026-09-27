# Production runs over the README use cases, second day — 2026-09-27

Eight runs on atoma.run, driven over the MCP from Claude Code, on revision
`64fb516` (the owner-approved fixes of
[2026-09-26](production-runs-2026-09-26.md)). Models: `own:openai`
gpt-5.6-luna / terra / sol for L1 / L2 / L3, except the comparison rerun.
Every run was read from its trace: tool arguments, tool results and the
root acceptor's full prompt and answer.

## The runs

| Run | Use case | Project | Outcome | Duration | Cost |
|---|---|---|---|---|---|
| R13 `dc45c95b` | SaaS: notes JSON API, 6 HTTP + 3 review criteria, project created over MCP | team-notes-api | delivered, published (created) | 384 s | $0.061 |
| R14 `a939374e` | Agencies: three-step package configurator, 7 review criteria incl. 375 and 1280 px | client-demo-configurator | delivered | 429 s | $0.074 |
| R15 `72e81903` | Data: order-file validation CLI, exit codes, `--json`, README | order-file-validator | delivered, one root remediation | 635 s | $0.142 |
| R16 `7389feee` | Agencies: continuation of R14 — currency switch, quote download, no test globals | client-demo-configurator | delivered, one root remediation | 1370 s | $0.335 |
| R17 `586c3fa5` | Retail: continuation of the sales dashboard — top products, CSV export, date range | sales-dashboard | delivered | 641 s | $0.127 |
| R18 `068cfe14` | Comparison rerun of R14 on L1/L2 terra | client-demo-configurator | partial: refused at delivery twice | 644 s | $1.240 |
| R19 `556c9e54` | SaaS: full-stack task board (API + page, persistence), 4 HTTP + 4 review criteria | task-board-prototype | delivered | 710 s | $0.207 |
| R20 `fda8cd47` | Data: technical documentation and a test script for R15's CLI, continuation | order-file-validator | delivered | 462 s | $0.119 |

What held: HTTP criteria are observed, not narrated (R13, R19); the criteria
grammar refused a criterion that named 400 where no status is read, with a
message that said how to write it; scratch inputs went to `.atoma-scratch/`
(R15); an unchanged-CLI criterion held byte for byte (R20); continuations
started from the delivered workspace (R16, R17, R20); a project whose
repository already belongs to another project is refused with that reason.
R14 started 85 s after R13 ended, inside the analyst's window, which is
consistent with the preemption shipped on 2026-09-26; the host's logs were
not read from here.

## Incidents

### J3/J6 — a width a criterion names was never laid out, and was judged met

R14's criterion "no horizontal scroll at 375 px wide and uses the extra width
at 1280 px" was approved with every browser check at 800x600, although the
acceptor's prompt carried the line "BROWSER LAYOUTS OBSERVED IN THIS ATTEMPT:
index.html at 800x600" added for exactly this on 2026-09-26. Its judgement:
"plausibly supports phone and desktop layouts". R16 was refused for the gap
on its first pass ("the only layout probe was 800px wide"), remediated with
six more checks, all at 800x600, and approved on "responsive rules and
overflow protection". R18, on terra, refused twice for the same gap and
landed partial: a stricter judge, and still no molecule that laid a page out
at 375 px. `validate_html` has had a `viewport` argument since 2026-09-25; no
molecule used it, the refusal naming the gap included.

**Fixed at the source, shown at the acceptor.** A screen width a criterion
names (`namedLayoutWidths`: "at 375 px wide", "a 375-pixel phone", "viewport
width of 1280 px"; "375 x 667 px" gives 375) reaches the planner's line for
the item and every molecule holding `validate_html`, at execution, as an
instruction to lay the page out at that width — the step no molecule took.
The acceptor reads `375 px: NOT LAID OUT, 1280 px: laid out, passed` beside
the item. It overrides no judgement.

**Owner decision, open: make an unlaid width a refusal.** The first version
held a user criterion unmet whenever a width it named was never laid out.
The adversarial review of that version measured it as a wrong gate: "375 x
667 px" was read as 667, and bare prepositions turned "downscaled to 1024
px", "thumbnails render at 256 px" and "below 768 px the nav collapses" into
widths, each a refused delivery. The narrowed parser handles those, but a
lexical detector that refuses is exactly what src/atoms/AGENTS.md rules out.
If the next runs still approve an unlaid width with the
instruction in place, the refusal is the owner's call.

### J7 — a `<select>` or a slider could not be driven

R19's worker tried three real ways to choose an assignee filter: a click on
the `<option>` ("no bounding box"), a click on the select then two
`ArrowDown` keypresses, then the same with other selectors. None changed the
value, because a headless page opens no dropdown. It proved the filter by
assigning `filter.value` and dispatching `change` from the smoke, which
executes no interaction. R18's worker pressed `ArrowRight` on a page-count
slider twelve times; `keypress` took no selector, so the keys went to the
checkbox clicked before it. R14 and R17 drove state through test hooks
(`window.__configTest`, `window.__dashboard`) and a button added for
validation. That is J3's other half: the self-driving smoke the root judge
accepted was often the only proof the tool allowed.

**Fixed.** `validate_html` has a `select` interaction: it chooses a
`<select>` option by value or label, or sets a range, date, month, week,
time, datetime-local, colour or number input, then fires input and change,
and it refuses what a person could not choose (not rendered, disabled, no
such option). Keyboard interactions focus their `selector` first.

### J5 — `write_file` reported characters as bytes

R14's `index.html` was reported as 11765 bytes and published as 11802: the
result counted UTF-16 code units. **Fixed**: both write tools report UTF-8
bytes.

### Not fixed

- **J1, review criteria met without evidence.** R13's "notes persist across a
  restart" was judged met on a restart with no request after it; "listed
  newest first" on a list of one note; "README documents every route" without
  the README being read back — the read-back only reads files the result
  names, and it said "README documentation". The layout fact above removes
  one class of these. **Fixed as well**: the files a criterion names are read
  back for the acceptor, and the criteria block says a review item is met
  only on what the evidence shows.
- **Test residue in deliverables.** `window.__configTest` shipped in R14
  (removed by R16 on request), `window.__dashboard` and a validation-only
  button in R17, `replacement-sales.csv` at R17's root, R13's probe note in
  `notes.json`. The `select` interaction removes the main reason for hooks on
  form controls.
- **Routing.** Every run went root → Idioblast, the full-stack cell, including
  a single static page and a CLI. It cost nothing visible.
- **GitHub import** was not exercised: every repository of the installation
  already belongs to a project, except a fork of the product itself.

## Verification on revision `78c3fff`

Two comparison reruns on the same models as their origins:

| Run | Origin | Outcome | Duration | Cost | What changed |
|---|---|---|---|---|---|
| R21 `adf4698d` | R14 configurator | delivered | 439 s | $0.085 | the molecule laid the page out at 375x800 and 1280x800 for the first time; the acceptor read `375 px: laid out, passed, 1280 px: laid out, passed`; the page-count slider was set by eighteen real interactions, keypresses focused on `#pages` |
| R22 `dbd59f12` | R19 task board | delivered | 498 s | $0.130 | the assignee filter was proven by `select "Taylor" in #assigneeFilter`, a real interaction, on the first try (R19: three failed attempts, then a smoke assigning `.value`; 710 s, $0.207) |

R21 still proved its totals with a smoke that drives the page through a test
hook (`window.__test`) at 375 px; the interactions that set the same state
passed at 800 px in the same attempt.

## J9 — a continuation replaced the deliverable it was asked to keep

R24 `902b2c21` (continuation of R16, revision `f18ca0d`, delivered, published
directly onto the project's `main`): "add a small marketing site around the
existing configurator … configurator.html, which holds the existing
configurator unchanged in behaviour". The molecule read R16's 13394-byte
`index.html`, wrote a home page over it, and wrote a 2090-byte
`configurator.html` from scratch: invented prices (Starter 1800, Business
3600, a "Scale" package, a 450 EUR blog), no steps, add-ons, currency switch
or quote download, and a total computed as
`pkg.value==='Business' && p===12 ? 290 : …` — exactly the 4340 EUR the
approved criterion named. The acceptor approved every criterion. R16's
configurator survives only in the repository's history (`763ecd1`).

Nothing the acceptor read compared a continuation's result with the
workspace it started from. **Fixed**: the runner snapshots the seed before
any model work, and a seeded run's acceptor reads each starting file
removed, rewritten (below half of its starting lines), changed or unchanged,
with its size before and after (`index.html: REWRITTEN 13394 → 2070 bytes,
keeps 0% of its starting lines`). Every molecule is told that kept files are
edited, not replaced, and that special-casing a criterion's value is a
forged result. No lexical detector for such a constant is proposed.

## Later runs on `f18ca0d` and `e2193a6`

| Run | Use case | Outcome | Duration | Cost | Notes |
|---|---|---|---|---|---|
| R23 `6c82f826` | Logistics: warehouse stock viewer, drafted checklist, 390 px phone | delivered | 225 s | $0.029 | laid out at 390x800 as the goal named; filters and slider still driven from the smoke (`dispatchEvent`), not `select` |
| R24 `902b2c21` | Agencies: four-page site around the configurator, continuation | delivered | 647 s | $0.154 | J9 above |
| R25 `65a7ae3c` | SaaS: notes API continuation — API key, pagination, tags, drafted checklist | delivered | 512 s | $0.102 | 401/400/pagination observed over HTTP; README criterion again judged on the file existing (J1); probe data in `notes.json` |
