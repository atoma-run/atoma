# TypeScript applications — owner decision 2026-10-16

All JavaScript-runtime applications produced or modified by Atoma use strict
TypeScript, including existing projects. The owner explicitly rejected the
new/existing exception and asked for a short uniform runtime prompt: Atoma is
in beta and migration impact is acceptable, including in production.

Migrate only Attica now; do not launch other project migrations implicitly.
The current Attica migration is run `e9c1775f-a530-44af-9c8e-ff9989ca0764`,
based on retained partial `6b6b1952-7750-4a02-831a-45c60d0997f4` in project
`07864f7c-d8f2-4023-9fca-afd8a7a51e52`. Review its final artifacts before
claiming completion. No Attica client acceptance or publication is implied.

Policy and rationale:
[decision](../docs/decisions/typescript-applications-2026-10-16.md).
