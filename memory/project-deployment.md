# Project deployment direction — 2026-10-14

Owner decision: project creation -> runs -> preview -> explicit client acceptance
and GitHub publication -> optional deployment. Deployment is a mutable setting
on the project: none (default), Atoma, or external. A project can be complete
without deployment, including documents, analyses and scripts.

Remove the recent local Docker onboarding from the platform and model prompts.
Do not infer local execution from CAPTCHA or require Docker Desktop by default.
Do not delete immutable deliveries, the Attica pilot/browser profile, or its 68
collected offers. Spitogatos stays paused; xe.gr remains the product priority.

Saving a destination is configuration only: no deploy, migration, stop or update.
Future deployment actions must name an accepted/published version; transitions
must preserve the current deployment until the replacement is ready. Preview
remains temporary, not production hosting. Persistent runtime, browser/manual
verification, data retention and external hosting connections remain to build.

Implemented in this iteration: persisted org-scoped preference, admin-only
same-origin update with stale-write protection, project settings in GPU and
accessible UI, honest availability copy. No hosting executor is claimed.

Attica project context revision 8 records this superseding owner decision,
including manual CAPTCHA handling without prescribing a local customer runtime.

Validation: 515 focused tests across project storage/service, permissions, UI,
preview, assistant, rendering and event contracts; typecheck, lint and docs
checks passed. Build and MCP OAuth browser smoke passed. The complete GPU
smoke passed after the new scenario used the intended viewport and restored
the conversation before continuing the upstream-setting scenario. Focused
Chrome journeys passed at 1600px and 900px with explicit save and re-entry.
