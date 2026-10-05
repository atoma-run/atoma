# Prospective reservation transaction experiment

Frozen before run start on production revision 628826cf. New private project,
empty starting workspace, deep supervision, unchanged production model defaults.
No additional monetary ceiling. One run, followed by independent artifact checks
and a complete paged trace review. Corrections or follow-up runs are separate
measurements; do not replace the initial result with a successful repair.

## What makes this harder

A durable HTTP service with multi-item transactions, cached successful AND refused
commands, concurrent contenders, explicit clock transitions and process restart.
The checked order distinction is real: confirmation before expiry consumes stock;
expiry before confirmation releases stock and makes confirmation fail. Unlike
the earlier invoice arithmetic example, the two observations cannot coincide.

## Independent oracle, before seeing the output

request.json is the exact builder contract. verify-artifact.mjs is external and
is NOT supplied to Atoma. `--plan` emits the frozen case inventory without a
server or paid calls; literal sanity assertions check oracle boundary arithmetic
and atomic refusal. Every sequential scenario compares exact HTTP status/body,
full state against an independent in-memory reducer, repeat GET bytes, and cached
response bytes. Restart steps send SIGKILL after an acknowledged response and
reuse the same DB. Three concurrent scenarios check last-unit conservation,
identical-key application once and conflicting-key refusal, without prescribing
which racing request wins. Their winning receipt is checked after restart too.

Use a reviewed immutable artifact in an isolated temporary-data environment;
the script starts only its server.js on loopback with a minimal environment.
No generated test suite substitutes for this oracle. Run the artifact's own
suite separately after reviewing its scripts and source. Preserve both results.

## Adversarial review and limits

- Failed commands may persist a receipt but never mutate the public domain state.
- Invalid schema is checked before receipt lookup and never claims a key.
- An old successful receipt must replay its original revision after later changes.
- A failed receipt remains failed after stock is released. A new key may succeed.
- Refusal fixtures isolate a single cause; no unspecified error priority is scored.
- Sorting is code-unit order, not locale order; IDs include prototype-like strings.
- Restart tests establish acknowledged durability, not a crash at every possible
  instruction or physical power-loss guarantees. SQLite internals are not inferred
  solely from a green restart test; inspect the delivered transaction boundaries.
- Concurrency checks are observations of paired requests, not exhaustive interleavings.
- The fixed-seed mixed sequence supplements literal boundary cases; it is not a
  substitute for independent expected outcomes or a statistical reliability claim.
- No runtime code changes, deploys, competing runs or heavy repository checks
  while the paid run is in flight. Archive recovered errors as well as failures.

After delivery, identify the exact publication receipt, verify artifact hashes,
run frozen checks, read all trace events including intermediate refusals, then
compare the analyst's claims to actual assertions. Report partial delivery and
missing evidence honestly. The run itself may fail; do not loosen the contract.
