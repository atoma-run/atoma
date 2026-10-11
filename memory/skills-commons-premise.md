---
name: skills-commons-premise
description: "Superseded 2026-09-15 by \"a run is a run\" — one registry, one skill catalog, one trust for the whole platform; the organisation bounds no knowledge and no trust"
metadata:
  node_type: memory
  type: project
  originSessionId: b191e91c-91f9-420e-b649-a2497430ae41
  modified: 2026-09-15T15:09:00.052Z
---

SUPERSEDED. On 2026-09-06 the premise was "skills are a commons; the organisation bounds TRUST and execution rights, never knowledge". On 2026-09-15 the owner went all the way: **a run is a run.** One registry, one skill catalog, one set of trust counters, one lifecycle ledger and one prefilter cache for the whole platform. The operator's runs, every organisation's project runs and the benchmarks read and write the same rows. The organisation bounds only projects, workspaces, traces, searchable documents and who may start a run. Project runs also promote, dispatch deterministically and use the cache like any run; a tenant launch insists on `--container` and on proving it is the registered run, nothing else.

Trigger: the owner logged into atoma.run as a brand-new member with zero runs and saw the Registry showing trust counters their runs would never move. Recorded in docs/platform-trust-2026-09-15.md (decision, code map, consequences, rollback); shipped in commits 2911881 and 63f5317.

Accepted consequence, characterised in tests/project-retrieval-privacy.test.ts rather than prevented: wording a validator derives from one organisation's retrieval corpus and writes into a prompt reaches every organisation's next run. The corpus itself does not travel. Mutually untrusted tenants are explicitly not a supported deployment shape, and SECURITY.md now excludes the shared commons from vulnerability scope.

Still open: owner decisions 7 (sharing terms for offered bodies, separate from the AGPL code licence) and 8 (lighter admission for instruction-text bodies).

**Why:** the user wants atoma to be a cooperative platform between developers; any partitioning of knowledge or trust contradicted that, and an isolation framing in the docs misdescribed the product.

**How to apply:** never reintroduce an owner, scope or per-organisation partition on the registry, the skills catalog or their counters. Read docs/platform-trust-2026-09-15.md before touching `openDb`, `AtomRegistry`, `SkillRegistry` or the coordinator's run environment. Do not design the body-admission mechanism in-session (cooling-off rule); it belongs to owner decision 8. Related: [[public-repo-licensing]].
