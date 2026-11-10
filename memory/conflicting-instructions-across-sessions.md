---
name: conflicting-instructions-across-sessions
description: "2026-11-10 — two sessions held opposite owner instructions on Wit (deploy it / hold it until the owner's test); the peer deployed first. Read the peer's memory note, do not cancel or revert its deployment, ask the owner with the facts; fetch origin before fixing a blocker a peer already names"
metadata:
  type: feedback
---

On 2026-11-10 the owner told this session « Déploie en prod tout, sauf la new feature wit qu'on ajoutera après test de ma part ». A Codex session had been asked earlier that morning to fix the two CI blockers and deploy Wit. It pushed 7d9a1dcf and cfad746c while I was fixing the same two blockers (the ag-psd advisory GHSA-6w3r-6hpr-hp6p and the dated `viz-assistant` assertion) in a scratch worktree. Its deployment was already streaming to the host activator when my fetch showed it, and production switched to a revision with Wit a few minutes later. I did not cancel the run or push a revert. I asked the owner, who chose to keep Wit in production and test it there. My two fix commits were dropped as duplicates.

**Why:** sessions do not see each other's instructions, and the owner can change their mind between two of them. The peer's own note ([[wit-deliverables]], "The owner requested fixing both release blockers and deploying Wit") was the only evidence that its push was instructed and not a mistake. Undoing it on my instruction alone would have set two agents against each other on `main` and put two more deployments through production.

**How to apply:**
- Before fixing a blocker that a peer's memory note already names, `git fetch` and look for its work; fetch again before each long verification. About twenty-five minutes of duplicate work came from skipping this.
- When a peer's push contradicts my instruction, read its memory note and commit messages for what the owner told it. Then ask the owner, stating what is live and what each choice costs.
- Do not cancel a deployment that is streaming to the activator on my own reading of an instruction. The activator restores the previous generation on a dropped channel (`deploy/host-deploy.sh`, the HUP trap), but a cancelled run is a red notification and an invitation for the peer to rerun it.
- A commit whose content is already upstream needs no rebase to leave a clean shared checkout: prove it with a diff of the two patches, then `git reset --keep origin/main`, which refuses to touch a file carrying local changes.

Related: [[shared-checkout-staging]], [[push-to-prod-authorized]], [[verification-speed]].
