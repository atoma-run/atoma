# TypeScript policy review — 2026-10-16 (amended)

Scope: runtime application language policy and the existing acceptance path.
This is a design/call-path review, not a measured claim about model compliance.

## Counterexamples considered

- The owner removed the new/existing distinction after the first implementation:
  all JavaScript-runtime applications use strict TypeScript. Updating an existing
  JavaScript application includes its migration. This may expand an application
  change; the owner explicitly accepts that consequence during beta.
- The rule does not launch migrations in other projects. Attica alone is being
  migrated in this session. Read-only phases still cannot modify source.
- A static HTML/CSS page, Python service, copied vendor asset, generated bundle
  or archival response HTML must not be rejected for lacking TypeScript.
- The earlier single-file/no-build exception was removed from the policy rather
  than retaining a second compatibility branch. Generated JavaScript remains
  deployable, while authoring and typechecking use the project-local compiler.
- A web molecule cannot run tsc. The existing canonical cell's unconditional
  one-molecule instruction conflicted with the new policy. It now permits an
  ordered build with a shell-capable molecule before browser verification.
  Its tool scope is unchanged.
- A `.ts` rename, transpiler success, native Node stripping, `echo ok` behind
  a typecheck script or a tsconfig excluding the app cannot establish success.
  Review asks for effective coverage and observed execution on final bytes.
- A fixture or generated JavaScript file cannot justify a blanket extension
  detector. The policy is semantic, not a filename rejection.
- A source-writing phase must not loop because another phase owns compilation.
  Current-phase scope remains explicit, as required by the planning-scope and
  first-refusal incidents. Final application acceptance still needs the check.
- A successful compiler run before later edits is historical evidence; the
  existing stale-evidence rules still apply. Supervisors do not replay commands.
- Existing recipes and stored prompts must not bypass the policy: the common
  runtime context reaches L1/L2/L3 and validation, including focused criteria
  reviews; the separate fallback proof turn receives the same constant.

## Verification and limits

Mocked production-path tests cover runtime planners, molecule execution,
fallback execution and final root review. The root test carries an attested
compiler error into a refusing review and verifies no supervisor replay.
These tests prove propagation and refusal handling, not the model's ability
to classify every repository or identify a deceptive typecheck command.
No additional LLM call, vocabulary classifier or automatic migration is added.
Production depth routing already reviews files through its empty proof floor;
the library's explicit covered-floor mechanical path is unchanged.

## CI regression and correction

CI run 38839568370 caught six calibration failures missed by the targeted
policy tests. The historical validation-prompt reader classified the new
multiline policy as task description text. Validation prompts now delimit
runtime guidance with `TASK_CONTEXT_HEADER`; the reader preserves support for
historical traces. Regression coverage runs the production `llmVerdict` path
through the reader, including multiline descriptions with a literal heading.
