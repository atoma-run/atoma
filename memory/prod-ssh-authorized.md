---
name: prod-ssh-authorized
description: Owner authorizes me to SSH to the production host mgf@atoma.run and use sudo when needed
metadata:
  type: feedback
---

On 2026-10-16 the owner said « tu as accès à ssh mgf@atoma.run (et peut même sudo dessus si nécessaire) » after I reported I could not inspect the host.

**Why:** I had stopped at a classifier refusal and left a production diagnosis (Docker address-pool exhaustion) unconfirmed; the owner expects me to inspect the host myself.

**How to apply:** for production diagnosis, still start with the Atoma MCP (AGENTS.md), then use `ssh mgf@atoma.run` with `sudo -n` for read-only inspection. Do destructive host actions only when they clean up what is provably orphaned or the owner asked. Ask before restarting Docker or services: that interrupts hosted apps and runs. Related: [[push-to-prod-authorized]], [[attica-run-delegation]].
