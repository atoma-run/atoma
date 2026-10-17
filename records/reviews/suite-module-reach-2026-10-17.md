# Suite module reach: replay gate — 2026-10-17

The host fact `src/atoms/parentSuiteReach.ts` adds to delegation reviews names
the modules a plan writes that no suite imports, names or calls into. Design and
stop rule: [parent-owned tests](../../docs/decisions/parent-owned-tests-2026-10-16.md).

## Gate design (pre-registered before any reply was read)

Recorded review prompts of run 760fef4c were rebuilt with today's review request
and HOST FACTS block (placement checked byte for byte through `llmVerdict`), with
and without the line placed as the last bullet of HOST FACTS ON THE SUITES, and
sent through the Codex transport: 11 calls.

- c3379f8c (root, gpt-5.6-terra): 3 without the line, 3 with it.
- fde6e0d6 (cell plan, gpt-5.6-luna): 2 with it.
- Negative control: c3379f8c with goal item 2 (the startup check in
  control-server.js) rewritten as a comment-only edit, 3 with it.

Land only if: refusals naming the control-server.js gap reach at least 2 of 3
with the line and at most 1 of 3 without it; the negative control gives 0 of 3;
no fde6e0d6 refusal rests on a misreading of the line. Without-line refusals
naming the gap in 2 of 3 or more would mean the review already catches it: do
not land. Replies were classified by random token, before the arm map was read.

## Classification

| call | arm | verdict | names the gap | line referenced / misread |
|---|---|---|---|---|
| aa9a5b9b | c3379f8c without #1 | approved | n/a | no |
| 3b9a8c09 | c3379f8c without #2 | refused | yes (framed as missing hash assertions) | no |
| 700c0a86 | c3379f8c without #3 | approved | n/a | no |
| 8dab2e72 | c3379f8c with #1 | refused | yes | implicit / no |
| 3404d199 | c3379f8c with #2 | refused | yes | implicit / no |
| 92116307 | c3379f8c with #3 | refused | yes | implicit / no |
| 99d2f10e | fde6e0d6 with #1 | refused | no (helper interface mismatch) | no |
| 1a124370 | fde6e0d6 with #2 | refused | no (helper interface mismatch) | no |
| bccebed8 | negative with #1 | refused | no (hashes, other assertions) | no |
| da1147cf | negative with #2 | approved | n/a | no |
| 4e457555 | negative with #3 | approved | n/a | no |

## Criteria as evaluated

- (a) with the line 3 of 3, without it 1 of 3: holds.
- (b) negative control 0 of 3: holds.
- (c) fde6e0d6 refusals resting on a misreading: 0 (both name a real interface
  mismatch of the helper the suite calls): holds.
- Without-line catch rate 1 of 3, under the do-not-land threshold. Verdict: land.

## Weaknesses the gate report lists

- One plan family (run 760fef4c), one module, three samples per arm: small.
- No reply cited the line explicitly; its effect is inferred from the arm difference.
- 8dab2e72 also carried a false claim unrelated to the line; one without-line
  refusal named the gap only through hash assertions (counted, borderline).
- The negative control changes the task text, not the line; it tests that the
  line does not create refusals where the task names no behaviour of the module.
- The replay used reconstructed workspaces and today's prompts, not the
  recorded run state.

## Implementation parity

The production module reproduces the prototype on the same corpus: 3 lines in
the 97 reviews past the precheck (c3379f8c, fde6e0d6, d8579413), the c3379f8c line
identical to the gate's; 0 in the 21 later reviews; every other block identical
to origin/main's; the zero-token precheck unchanged on all 122 reviews.
