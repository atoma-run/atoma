# A text delivery's answer goes in `output` — 2026-10-13

Owner request, 2026-10-13: make a text answer readable for the person who asked.

## Incident

Run `4e5c5c4b` (production, 2026-10-12) reviewed a CSV tool without changing any file.
Its deep root plan declared `delivery: "text"`: one sequential phase routed to Guard.
Guard's prefilter shortcut sent it to the molecule Ammonia.

Ammonia's stored prompt teaches the file-builder envelope: `output: {files, probes}`, with
evidence after `== GROUND TRUTH ==` in the summary. It returned `output: {files: [], probes}` and
wrote the whole ranked review into the summary, mixed with checksums, probe commands and exit
codes. The client read that block as the answer.

The root plan's `delivery` existed only at the root. It was recorded for acceptance and for the
manifest, and never reached the molecule. The root planner also wrote "State which execution
probes ran and their results" into the phase text itself.

Reasoning-mode tasks were not affected: they have no tools, and their guidance already asks for
the answer in `output`.

The display was fixed first in a05ea10f. The reader shows the summary's lead, moves the evidence
block to the technical details, and draws Markdown as headings and paragraphs. That cannot
separate an answer the agent wrote inside the evidence. This change fixes the source.

## Mechanism

**Stamping the root.** `withPlannedDelivery` marks the ROOT task `delivery: 'text'` once its plan
is recorded and declares text. It is called at:
- the L3 root;
- its checkpoint resume (a client-answer continuation keeps the saved plan's delivery when the
  replan omits it);
- SHORT depth's root, `shortRootHandle` in `src/run/runner.ts`, which the regression test now
  imports instead of copying.

**Passing it down.** `delegatedDelivery` hands the mark to the children whose output IS that
text:
- the last phase of a sequential plan, since earlier phases feed the next phase, not the person;
- every part of a `concat` or `llm-synthesize` plan.

It never goes to a child that declares file `outputs`, and only the root decides: a nested plan's
own `delivery` field is still not read.

**What each reader sees.** `taskContextLines` shows the line before the inputs, because Decision caps
its context head-first:
- **Executors** (L1 plan and execute, L2 and L3 self plan and execute) get
  `TEXT_DELIVERY_GUIDANCE`:
  - `output` is one Markdown string written for the person;
  - this replaces the file envelope;
  - evidence goes after the marker in the summary, even when a phase description asks for it.
    Only the person's original request can bring evidence into the answer.
- **Planners and validators** get `TEXT_DELIVERY_CONTEXT`:
  - judge the answer wherever it was placed;
  - never refuse a correct result for its placement alone;
  - never propose that placement as a lasting prompt change.

It is runtime text. No persisted prompt, recipe or seed carries it.

**Free-text URLs.** `extractResultUrl` now yields loopback URLs only. A Markdown answer
routinely cites external pages, and the first of them must not become a supervisor probe.
Explicit `output.url` and bare-URL outputs are unchanged.

**Display.** The result reader reads a concatenated answer, nested at any depth, as text. "Copy
complete answer" copies that text; the JSON download is unchanged.

## Adversarial review and dispositions

An independent review of the first version found:

1. **BLOCKER — fixed:** free-text URL extraction scanned the new Markdown `output` before the
   summary. A static-web validator would have browsed the first external link the answer cited.
   This is supervisor egress, and a false "not running" contradiction offline.
2. **Fixed:** a wrongly declared text plan could make a phase that declares `outputs` skip its
   file.
3. **Fixed:** validators read the executor's instruction.
   - They could refuse a content-correct result for its shape, for example a compiled script's
     envelope or a molecule whose stored contract wins.
   - They could also persist that shape as a prompt patch in a type that files runs use.
4. **Fixed:** "your part of it" contradicted sequential plans, where only the last phase's output
   is delivered.
5. **Fixed:** a client-answer continuation dropped the delivery when its replan omitted it. That
   expression has no dedicated test.
6. **Fixed in the reader:** nested concat arrays, and copy as JSON.
   - Accepted: `showcase.ts` and `previousResults.ts` still encode arrays as JSON.
   - Accepted: a files run whose concat output is plain strings now shows them as an Answer.
7. **Fixed:** the tests now cover the real paths.
   - `l3.handle` (the production root) dispatches the mark to the last of two phases only.
   - The SHORT cell path runs the molecule and its validator.
8. **Fixed:** the line now precedes the inputs that Decision's head-first cap cuts.
9. **Accepted:** some checks go quiet or slow down on text phases.
   - With `output.probes` and `output.files` gone, the `reportedWebProbes` manifest cross-check
     and structured file claims no longer fire there. Transport witnesses remain the primary
     proof.
   - `web-styling-evidence` asks for review on every string output of a validate_html molecule
     whose phase mentions styling, so the fast path is lost.
10. **Accepted:** `delivery` is chosen by the root planner, a model reading untrusted inputs. A
    wrong "text" can now change a phase's output shape. It can no longer suppress a declared
    file (point 2), and it never reaches publication: text deliveries never publish.

## Tests

- `tests/text-delivery-answer.test.ts`: stamping, per-phase dispatch, executor versus reviewer
  lines and their position, a real tissue root, and loopback-only URLs.
- `tests/short-text-delivery.test.ts`: the SHORT production handle, molecule plus validator, and
  silence before a plan declares.
- `tests/run-result.test.ts`: nested parts and copy.
