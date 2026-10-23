# Publication after a manually committed seed

Observed 2026-10-23 in Attica run `84ae80d1-5cba-497c-b99e-b2663a7f96bc`.
Its selected seed was `82c3fcd4-aafa-4b07-b8ad-539450119fc5`, manually
reviewed and pushed as `31c45e19c8b8ced0ff2a1450851c88239a605ff0`.
The saved repository base still named `d1abd91fb1d04d50ed3ed76ee61967980554c820`.
Atoma's publication ledger did not record those manual commits.

The delivered manifest was
`cc8446398198061dffb8130ded9090d67451b471b259bfeef13196ac1fa98d65`.
Publication `8c52bcd79018638dd72ef64a62faf49d5c51163e` added three new
files but omitted five changed ones: `browser/control.ts`,
`dist/browser-assets/control.html`, `dist/browser/control.js`,
`dist/browser/control.js.map`, and `vitest.browser.config.ts`.
The unchanged seed bytes on main looked like client conflicts against the
older base. Attica was repaired separately in `258318458f42406dc5a519dd72563e1548fc4c48`.

The publisher now recognizes a selected seed only through the recorded seed
identity and same-project lookup. For each debt path it re-reads that seed's
manifest entry, verifying bytes and mode, and advances the in-memory base only
when the observed remote Git blob and mode match it exactly. No commit prose,
ancestor heuristic, model assertion or new acceptance is used. Missing,
expired or changed seed evidence retains the existing conflict policy.
Concurrent client edits/deletions still win. Publication remains additive;
this fix introduces no remote deletion or historical receipt rewrite.

The stateful fake-GitHub regression in `repository-sync-coordinator.test.ts`
reproduced the five omissions before the fix, then passed with all five
updates, the addition, and an unrelated client file preserved. Negative cases
cover concurrent edits/deletions and changed/expired seed evidence. The
existing recorded-publication and selected-version conflict tests also pass.
No Attica test or paid run is needed to reproduce this engine defect.
