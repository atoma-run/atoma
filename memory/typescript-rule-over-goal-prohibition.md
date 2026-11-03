---
name: typescript-rule-over-goal-prohibition
description: "Owner decision 2026-10-31 — the strict-TypeScript application rule wins over a goal's \"do not rewrite the CLI\"; benchmark goals must not prohibit the migration"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 45327728-5279-46b5-99cc-bb4f31b3b2b4
  modified: 2026-10-31T18:15:02.209Z
---

**Superseded 2026-11-02:** the rule now covers new applications only and existing code keeps its language ([[typescript-applications]]), so a maintenance goal no longer triggers a migration. Benchmark goals still must not forbid a migration the product asks for.

On 2026-10-31, after rounds 13-14, I flagged that `APPLICATION_TYPESCRIPT_GUIDANCE` made every atoma run migrate the tabstat JS CLI to strict TypeScript against the goal's clause "Do not rewrite the CLI". The owner decided: the TypeScript rule of 2026-10-16 stands and is NOT overridden by such a clause. "We want to produce TypeScript."

**Why:** the rule is a product decision (all JS-runtime applications, existing ones included, use strict TypeScript); the tabstat goal was written in August before that decision and its prohibition measured the product against an obsolete expectation.

**How to apply:** do not add a precedence fix giving goal prohibitions priority over the skeleton guidance. Benchmark goals written after this date must not forbid the TypeScript migration; scorers judge behaviour (outputs, exit codes, held-out tests), never the language or file layout. Round 15's Attica tasks ([[benchmark-round15-calibration-2026-10-31]]) are written that way. Related: [[benchmark-round13-14-2026-10-31]], [[typescript-applications]].
