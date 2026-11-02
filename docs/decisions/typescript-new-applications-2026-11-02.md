# Strict TypeScript for new applications; existing code keeps its language — owner decision 2026-11-02

Status: decided on 2026-11-02 and implemented on branch `feat/direct-depth`
with the direct depth. It narrows
[TypeScript for all JavaScript-runtime applications](typescript-applications-2026-10-16.md)
and the scope of the [application skeleton](application-skeleton-2026-10-16.md).

## The decision

> A new JavaScript-runtime application is written in strict TypeScript from
> the versioned skeleton. Existing code keeps its language: a repair or a
> feature in existing JavaScript stays JavaScript, and existing TypeScript
> stays TypeScript. Existing JavaScript is migrated only when the task or the
> project context asks for that migration.

The owner chose this on 2026-11-02 among the three ways forward
[round 16](../../benchmark/ROUND16.md) reported, after checking what it means
for Attica, whose application code is already TypeScript.

## Why

The rule of 2026-10-16 asked every run that changed an existing JavaScript
application to migrate the code it touched, and on 2026-10-31 it was held to
win over a goal's "do not rewrite". Round 16 measured what that costs once one
agent carries the task:

| Run | Migrated or scaffolded | Executor cost |
|---|---|---|
| tabstat, direct, three runs | yes, the whole three-file CLI | $0.56 to $0.70 |
| tabstat, control | no | about $0.19 |
| challenge, direct, two runs | yes, a skeleton around one module | $0.66 and $0.73 |
| challenge, direct, one run | no | $0.30 |
| challenge, control | no | $0.25 to $0.34 |

On a small project, "the code the repair touches" is the whole project, and a
single module given to extend became a scaffolded application. The migration
bought no correctness on either task: the scorers judge behaviour, and the run
that did not migrate scored full marks at the control's cost.

## What the runtime rule now says

`APPLICATION_TYPESCRIPT_GUIDANCE` in `src/atoms/taskContext.ts`, read by every
tool-mode planner, executor and reviewer, as before:

- **New application.** Strict TypeScript, from the skeleton, with its
  lockfile and `check`/`build` scripts.
- **Existing code.** Keeps its language. No skeleton, package manifest,
  linter, test runner or build step the task does not ask for is added to an
  existing project, module or script.
- **Migration.** Only when the task or `projectContext` asks for it.
- **New, defined.** A directory with no application source, no package
  manifest and no enclosing package; a new module, script or package inside an
  existing project follows that project.
- **Acceptance.** Every check, build, typecheck, lint and test script the
  application defines must be observed passing on the final source; one that
  defines none is judged on functional checks. Type stripping alone is not
  proof of type correctness, and an existing TypeScript module with no
  typecheck command is judged on functional checks.
- **Unchanged.** Inspection, verification-only and reporting phases still do
  not migrate or repair; error suppression is still refused; generated
  JavaScript and tooling glue are still valid.

The three deep-path lines that named "TypeScript application" when every
application was one (the parent-test planning instruction, the delegation
review's vitest classification and the parent-test review) now name
JavaScript or TypeScript, so a JavaScript application keeps its parent-owned
suites; the host's runner already imports CommonJS modules. `run_shell`'s
description says the scaffold is for a new application.

## What it means for Attica

Attica's application code, its server, collector, browser session, store and
scheduler, is already strict TypeScript, and stays so. Its remaining
JavaScript (about thirty test files and a few collection scripts) is no longer
converted when a run touches it. A full migration of those files is a task to
ask for.

## Adversarial cases

Reviewed before landing. The review's findings and what was done with each
are in
[`records/reviews/typescript-new-applications-2026-11-02.md`](../../records/reviews/typescript-new-applications-2026-11-02.md).
The rule defines a new application (a directory holding no application
source or manifest and no enclosing package), names `node:test` for tests
asked of a JavaScript project without a runner, and requires every check,
build, typecheck, lint and test script an application defines rather than a
fixed pair.

## How to undo it

Restore the 2026-10-16 wording of `APPLICATION_TYPESCRIPT_GUIDANCE`, of the
three deep-path lines and of `run_shell`'s scaffold sentence. Nothing is stored by this rule, so no migration is needed.
