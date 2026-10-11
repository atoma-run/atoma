---
name: run-family-removed
description: Run "family"/TaskProfile removed 2026-10-03 (eb24f1c3, live in prod); burn-in "family" label kept on purpose
metadata:
  type: project
---

The root tissue chosen by `selectTissue` IS the kind of work, so the run family is gone: no TaskProfile, `startTask(argv, opts)`, `src/run/setup.ts` + `guidance.ts`, MCP `atoma_families`/`atoma://families`/`atoma_goal_<id>` removed (one `atoma_goal` prompt, 40 tools), `projects.family` column dropped on store open, `/api/goal-guidance` replaces `/api/profiles`.

**Why:** the user asked for the "grand ménage" ("L3 EST la family"); a second selector beside selectTissue can only disagree with it. Recorded as a rejected shortcut in src/run/AGENTS.md.

**How to apply:** do not re-propose a family/profile. The burn-in/curriculum "family" is a task-category label (CSV column), a different notion left in place; renaming it to "category" was offered, not decided. `run:build`/`build-app`/`ATOMA_BUILD_*` stay as legacy names.

Gotcha learned: a CI-vs-local test trap — an MCP smoke call that reads the local store (`atoma_registry_list`) passes on a dev machine and fails on a clean CI checkout; use `tools/list`. Also a parallel agent pushes viz commits to main (showcase) and the i18n bot pushes `[skip ci]` locale commits: always `git fetch` and rebase before push. See [[push-to-prod-authorized]].
