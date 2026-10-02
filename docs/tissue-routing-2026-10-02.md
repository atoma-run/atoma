# Task-driven root tissue selection — 2026-10-02

The user asked to remove the one-to-one relationship between a run profile and
an L3 tissue. A request to explain an imported repository must not inherit an
application-building mission merely because the legacy launch command is
`run:build`.

## Contract

The run receives a required goal and optional starting repository. Before tool
execution, the host records a bounded inventory and excerpts of ordinary README
and package manifest files. Hidden files, links, generated directories and
special files are omitted; limits and read failures mark the context incomplete.
The repository supplies evidence about the setting; the goal defines the work.

`selectTissue` offers the platform registry's L3 capabilities to Jev, including
their reusable methods. An exact positive choice passing the existing confidence
and fit policy selects that identity. Root choices are binding, so they use the
strict policy even when a caller attributes them to tier 3; they are not the
weaker hints used before an L3 strategy call.

Absent, uncertain, invalid or unavailable Jev decisions use one bounded call to
the run's configured tier-1 model. It can reuse an offered tissue or request a
missing capability. It cannot author the persistent method. The platform's
`ATOMA_MODEL_L3` writes that method in one text-only call with high reasoning
effort (owner clarification 2026-10-02). This is the exact host pin, not a
model ranking or the requesting admin's account pin in Settings.

The coordinator captures that selector and its host credential/profile before
resolving customer overrides, in a separate internal environment envelope.
A dedicated client uses the platform's API key/endpoint or host subscription,
even if the customer uses the same vendor or a personal ChatGPT profile.
The subscription is authorized for this platform catalog operation, not for
the customer's ordinary run tiers. Transport model debug overrides do not
replace the author pin. No envelope or credential enters a prompt, trace or
tool process; subscription subprocesses cannot inherit the envelope either.
Missing platform configuration blocks only creation and never substitutes a
customer credential. The author is constructed lazily, so reuse adds no call.

Author calls are recorded as `platform-tissue-author` with the requested and
served model, usage and cost; they share run limits and accounting. They are
platform-paid catalog work, distinct from the run's ordinary per-tier payer
ledger. The registry allocates or reuses the identity
through `createOrReuse(3)`; it retains the usual shared trust and provenance.
The decision schema cannot supply tools, model selectors, budgets or runtime
configuration. Generated methods receive the common L3 delegation protocol.
Invalid model output fails the run instead of silently selecting the builder.

Task-specific content stays in the task. The routing prompt forbids copying
repository bytes, names, requested values and acceptance criteria into a
persistent method. This is a model instruction, not a proof that every generated
method will generalize. Repository and catalog text are marked untrusted in both
the Jev and model paths.

Ordinary runs now start in deep mode and use the selected L3. Selection happens
once per run and survives root remediation. Explicit `--depth short` retains the
existing L2 entry and selects an L3 only if it deepens. The baseline keeps its
single-agent entry; registered comparison arms keep their fixed builder entry.
Root acceptance, approved checklists, verification, cancellation, accounting and
workspace reseeding remain on the shared runner path. This change does not
establish comparability with benchmark results from earlier code revisions.

`TaskProfile` now holds technical launch configuration, workspace preparation,
the canonical child catalog and help. It no longer has `seedL3`, `buildTask` or
a sample application's default goal. `build`, `build-app`, `run:build` and
`ATOMA_BUILD_*` remain compatibility names. The canonical builder is seeded by
the runner as one candidate; it cannot overwrite an unrelated tissue that
received the botanical name Meristem.

Meristem's canonical prompt now explicitly decomposes the goal into one or
more subtasks, selecting an L2 cell per subtask. Different L2s can work on
different subtasks; dependencies run sequentially, independent work may run in
parallel. The existing dispatcher already supports this. Seeding upgrades an
old canonical prompt once, resets its trust streak and preserves historical
success/failure totals; unrelated custom tissues are not rewritten.

## Adversarial review against the incident record

| Failure mechanism | Decision and executable coverage |
| --- | --- |
| Different methods share tools or a description ([catalogue measurement](incidents/registry-catalogue-2026-09-16.md)) | Root candidates include their methods. A Jev fixture distinguishes two equal-description, equal-tool tissues. Registry equivalence still owns exact deduplication. |
| A stored agent carries a previous task ([J10](incidents/production-runs-2026-09-27.md)) | Current context is passed as task data, not interpolated into the persistent prompt. The creation fixture verifies host isolation of that data and subsequent identity reuse; real model generalization remains unmeasured. |
| A relative winner lacks positive fit ([Jev policy](jev-policy-2026-10-01.md)) | Root scope preserves the strict confidence and fit checks. Tests cover uncertainty, no candidate, unknown target, low confidence and outage; all defer to the one model decision. |
| A selected agent requires absent capabilities | Candidates with unavailable tools are omitted. A model selecting an unoffered identity is rejected; generated tool or runtime fields are rejected by the schema. |
| A deepening changes the initial evidence ([seed inheritance](seed-inheritance-2026-09-25.md)) | Selection reads the initial snapshot and uses the existing reseeding path. Restart tests retain their explicit short mode. |
| A bootstrap rewrites a newly allocated Meristem | Canonical seeding recognizes builder provenance or the legacy canonical description. A custom Meristem survives a later bootstrap unchanged. |
| Cancellation causes follow-up spend or catalog writes | Abort checks bracket Jev, the model and registry creation. Tests cancel at each asynchronous boundary. |
| Customer pins or credentials author a shared tissue | A real child-process test goes from the coordinator snapshot through SDK construction and a mocked HTTP request, proving the host pin, gateway and key survive same-vendor customer overrides. Separate tests cover personal Codex profiles and Claude login snapshots. |
| A cheap router publishes a prompt or author failure silently bills the customer | Separate strict decision/definition schemas; only the platform author supplies persistent text. Missing, failed, invalid and cancelled authors allocate nothing and trigger no customer fallback. |
| Seed wording restricts Meristem to one L2 | A real L3 plan and dispatcher send two subtasks to two different registered cells. Bootstrap tests exercise the one-time prompt upgrade and preserved history. |
| A non-build task inherits mandatory file creation | The runner carries the goal without profile constraints. An integration test imports a repository, routes to an analysis tissue, reads through L1 and delivers text without changing files. |

These tests use mocked decisions and providers. They establish routing and
lifecycle behavior, not a measured improvement in Jev accuracy, task success
rate or live model cost.
