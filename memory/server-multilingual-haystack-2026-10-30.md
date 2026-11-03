---
name: server-multilingual-haystack-2026-10-30
description: 2026-10-30 server ATOMA_HAYSTACK_CONFIG switched from English BGE to the multilingual E5/mMARCO pair used by Compute; activation via deploy of e316edbf
metadata:
  node_type: memory
  type: project
  originSessionId: 14044d02-783e-4841-b165-a6a64521f7cd
  modified: 2026-10-30T10:09:23.275Z
---

On 2026-10-30 the owner authorized updating production so project search covers the 13 Atoma locales on hosted (server) runs too; Compute devices already had multilingual models since a5b7bde7 (2026-10-18).

- Models copied from the published amd64 Compute retrieval image (receipt of 344f81f5) to `/home/atoma/haystack-20261030/{embedding,reranker}`; pins 8481cae… / b4ef9bd… equal the receipt and the Mac's BY_DEVICE entry. Venv unchanged (`haystack-20260909/venv`, runtime 99af176…).
- `/home/atoma/config/atoma.env` line ATOMA_HAYSTACK_CONFIG replaced; backup `atoma.env.before-multilingual-haystack-20261030T100043Z`. The env file is root-only: read values from `/proc/<pid>/environ`, not by sourcing it as atoma.
- Smoke through the release's own binding/tool: 26/26 multilingual vs 16/26 English (all failures cross-language). Python peak RSS 686 MB → 1.44 GB per run. Record: `records/releases/server-multilingual-haystack-2026-10-30/`.
- Activation: running web/executor keep the old value until a new executor generation starts; pushed e316edbf (docs) to deploy it rather than restart the executor under a live Compute run. CI + deploy green 10:08 UTC; web and executor@e316edbf verified carrying the new value.

**Why:** a project without a Compute device runs on the server by default, and there cross-language search failed.

**How to apply:** when a Compute retrieval image changes models, re-copy the server models from the same receipt so both paths pin identical bytes. Large-corpus preparation time with E5 on the server is unmeasured. Related: [[attica-haystack-startup]], [[deploy-pipeline-state]], [[prod-ssh-authorized]].
