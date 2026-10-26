---
name: validation-runs-too-slow
description: Owner finds deep Atoma runs far too slow for a pure validation (no file change) of Attica; prefer direct local validation or a short-depth run
metadata:
  node_type: memory
  type: feedback
  originSessionId: 2342e190-d6b4-42e5-8b19-eccf44b5d18f
  modified: 2026-10-24T15:24:12.229Z
---

On 2026-10-24 the owner interrupted a fourth relaunch of the Attica "offline
regression validation" goal: "C'est tellement long pour juste valider le projet
sans modifier aucun fichier". That day three such runs (f41efe87, 9a2f8487 and
87471f50) cost $4.4 and delivered nothing; each deep run re-inspected the whole
repository through a tissue before running the first npm script.

**Why:** a deep run's topology (tissue, decomposition, parent suites, root
acceptance) is built for work that changes files. For "run these three known npm
scripts and report", that machinery is overhead and exposure to validation slips.

**How to apply:** for a validation with no expected file change, offer first to
run the checks directly on the Mac (clone, npm run check, browser suites, one
mutant/restoration), or at most a `depth: short` Atoma run. Reserve deep Attica
runs for tasks that actually modify the project. Never relaunch the same goal a
fourth time without asking. See [[attica-2428-reboot-analysis]].
