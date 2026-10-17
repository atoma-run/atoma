# Suite interface evidence — 2026-10-17

Attica run `034d176d-3b28-4ef6-9314-3376ab8a84ef` ended partial. Parent suites
`2ce8fde45b1fc872` and `81c001826eb5cd81` failed before their intended CAPTCHA
and Retry-After assertions: their collector arguments omitted required `output`.
The authored source also called `getPauseState`, while the store exposes
`loadPause`. Import existence facts did not show either interface to review.

The repair adds bounded current imported source to that existing review, using
the shared evidence reader. It does not execute imported code, auto-approve a
suite, infer semantic coverage, or add model calls. Six direct source imports
and 24,000 source characters are initial resource bounds, not measured recall.
Indirect imports, package entries and omitted sections remain limitations.

Adversarial review against the earlier host-facts incidents:

- A host read used to authorize blind child overwrites. Observation-only reads
  now withhold `markSeen`; the regression failed before the fix and passes after.
  A caller opting into that flag gains no authority. Ordinary reads still grant
  permission and later observation does not revoke it.
- A directory read failure must not become false absence. The existing fail-open
  listing rule remains; a source read failure explicitly establishes no content
  or absence. Source is labelled untrusted and current, not an instruction or a
  prohibition on the task's requested API changes.
- No dependency walk or source-import coverage gate is introduced: the earlier
  JS-to-TS twin, transitive-import and alias counterexamples still apply.
- All reads use the existing sandbox executor, including referenced fixtures.
  Read count and source allowance remain bounded; repeated imports are deduplicated.

The production parent-test harness, across its subprocess boundary, reproduces
the required-argument failure and then passes with correct arguments and method.
The root-review test verifies that source actually reaches the model request.
Other tests retain overwrite refusal and cover bounds and unreadable source.
These deterministic tests establish the evidence plumbing, not model accuracy.
