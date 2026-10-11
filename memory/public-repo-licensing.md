---
name: public-repo-licensing
description: atoma is public under AGPL-3.0-only (switched from FSL on 2026-09-06) with a CLA that allows commercial exceptions but commits to staying OSI-licensed
metadata:
  type: project
---

Licence history: on 2026-09-04 the user first chose FSL-1.1-ALv2 (source-available). On 2026-09-06, after stating that atoma should become a collaborative platform between developers, they switched to AGPL-3.0-only: `LICENSE` is the verbatim gnu.org text (sha256 0d96a4ff…), package.json and package-lock.json carry `AGPL-3.0-only`, README has a "License" section, CONTRIBUTING.md, CLA.md (Greek law, Athens courts, section 5 commits to staying under an OSI licence while allowing commercial exceptions) and SECURITY.md exist. Release archives copy LICENSE and SECURITY.md.

Business model agreed: AGPL core in the public repo, hosted platform and enterprise/control-plane pieces as the revenue, commercial licence exceptions for closed embedding (needs the CLA). A future thin client SDK would go Apache-2.0.

**Why:** relaxing a licence later is free, tightening is a reputational rug pull; the user chose the committed open-source path for community formation.

**How to apply:** README and docs say "free and open-source" / "open source" now, never "source-available". Do not reintroduce Competing-Use style clauses. Skills offered to the platform catalogue still need their own licence terms (Apache-2.0 or CC0 by the author) — not yet written. CLA Assistant Lite workflow not yet added. Related: [[business-entity]].
