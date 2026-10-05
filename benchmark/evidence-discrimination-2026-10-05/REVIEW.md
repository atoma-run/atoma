# Evidence discrimination change

The invoice counterexample is an unsupported validation claim, not an invoice
arithmetic defect. Moving payments before credits leaves every generated test
passing (the immutable mutation receipt is in the adjacent invoice archive).

The shared runtime guidance now asks what contract-relevant wrong behavior
would change the checked observation. It distinguishes source properties from
executed behavior and forbids claiming a mutation was executed without a host
record. Focused review inventories all visible missing parts together and does
not import new requirements from remediation prose. The analyst receives the
same guidance and must examine the changed assertion before calling recovery
successful. No extra calls, models, execution permissions or retry budgets.

## Paired measurement

Twenty original calls and four explicitly supplemental calls used gpt-5.6-luna
on the same day, with alternate baseline/candidate order. Requests, full
responses, usage and judgments are retained. The default replay makes no calls.

- On both exact production requests, baseline approves c3 while describing the
  arithmetic assertion as credit-before-payment evidence. Candidate refuses the
  order claim: reversal leaves the asserted outputs unchanged, and the source
  loops are absent from the supplied excerpt. Both continue to support c4.
- The original protocol mistakenly expected these archived cases to pass, since
  it assumed complete CLI source was present. The original raw scores remain:
  baseline 10/10, candidate 7/10. Those scores are **not accuracy estimates**.
  LABEL-AUDIT.md records the mistake and why the archived labels are wrong.
- Both arms reject the explicitly required distinguishing test using commutative
  subtraction and accept the noncommutative discount/fee test. Both accept a
  source-only order requirement and documentation. Both reject missing evidence
  and a refusal caused by absent authentication.
- Both enumerate missing JPY/KWD subtotal and tax assertions and the omitted
  audit.json comparison in one compound review. This control does not establish
  an improvement over baseline in first-pass completeness.
- Candidate refuses the original components-positive control because it lacks
  setup linking the variables to currency inputs. Keep this disagreement; it
  illustrates sensitivity to incomplete fixtures. Supplying explicit input
  setup resolves the refusal in the supplemental paired case (both accept).
- With the exact final production request plus the immutable complete CLI source,
  both accept. Candidate explicitly cites source order alongside executed amount
  assertions; it does not require another order-sensitive test. This is supplied
  additional evidence, not a claim that production already showed those bytes.

## Limits and adversarial review

This is one sample per case/arm on a known incident. It establishes that the
candidate stopped these two observed false proof approvals and accepted the
missing source evidence. It does not establish general proof reliability,
universal first-pass completeness or a measured improvement in complete analyst
sessions. The analyst's policy delivery is covered by its subprocess test.

Production read-back remains bounded. If source is omitted, a reviewer may need
to request it; this change does not enlarge or silently reconstruct excerpts.
The model can still make semantic mistakes. Negative and positive controls,
the mistaken preregistered labels and all raw responses remain reviewable.
See PROTOCOL.md for the adversarial review against earlier assertion, stateful
and keyboard incidents. Mock tests verify policy delivery, bounded calls and
judgment propagation; the real paired calls supply the semantic observation.

Reproduce both saved series with pinned Node:

```sh
node --import tsx benchmark/evidence-discrimination-2026-10-05/replay.mjs
node --import tsx benchmark/evidence-discrimination-2026-10-05/replay.mjs --supplement
```

## Source verification

Pinned Node 24.20.0, `npm ci` then `npm run release:check`: passed.
Both TypeScript configurations, lint, audit (zero vulnerabilities), build,
compiled MCP/auth/CLI smokes and the full suite passed: 409 test files passed,
one skipped; 5,375 tests passed, 19 skipped. Both saved replay commands also
completed offline without input-hash drift. These counts describe this local
environment, not a claim that skipped checks ran.
