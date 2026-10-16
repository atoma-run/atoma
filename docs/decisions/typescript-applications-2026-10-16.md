# TypeScript for new JavaScript-runtime applications

Accepted by the owner on 2026-10-16.

New applications targeting a JavaScript runtime use TypeScript with strict
checking for first-party browser and server logic and maintained tests. They
include reproducible development dependencies, a typecheck command and a
build/runtime setup. Generated JavaScript remains a normal deployment artifact.

Existing JavaScript projects retain their language unless the client requests
migration. Adding a file or component to an existing project does not make it
a new application. Attica is explicitly authorized for migration; no other
existing project is included in that request. Explicit client language and
packaging constraints take precedence. HTML/CSS-only pages, other languages,
data and third-party assets are outside this policy.

Planning, execution and validation share the runtime guidance in
`src/atoms/taskContext.ts`, so catalog entries created earlier receive the same
rule. Compilation must be assigned to a molecule with shell tools; a static
browser molecule verifies the built output. No new shell access is granted to
that narrower molecule.

Final application acceptance requires observed successful typechecking of the
final source and review of effective configuration and command coverage.
Transpilation, Node type stripping, a `.ts` filename or a script named
`typecheck` does not establish this. Error suppression and source exclusions
cannot substitute for types. Functional and browser checks remain required.

This is part of the existing semantic acceptance review, not a new lexical
gate or an independent compiler service. Supervisors inspect observed evidence;
they do not execute project-authored scripts. A delegated phase is judged on
its own responsibilities; compilation assigned to a later phase does not
invalidate an earlier source-writing phase.

Adversarial review: [scope and verification cases](../../records/reviews/typescript-policy-2026-10-16.md).
