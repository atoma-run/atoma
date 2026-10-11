---
name: server-dev-checkout
description: atoma.run has a source checkout for mgf at ~/dev/atoma, stored on the 50 GB Hetzner volume; the volume otherwise holds only OpenClaw backups
metadata:
  type: project
---

Since 2026-10-02, `mgf@atoma.run` has `~/dev -> /mnt/HC_Volume_104738584/mgf/dev` and a clone of
`git@github.com:mgtf/atoma.git` at `~/dev/atoma` (npm ci done, Node 24.20.0 is the system node).
The same volume (50 GB, ext4 made 2026-02-20) holds the OpenClaw daily backups via
`~/backups` and `~/openclaw-backups-private` symlinks; `backups/openclaw/` keeps 2.3 GB of
August 2026 archives with no retention. Root disk is 38 GB at ~80 %. Atoma production lives
under the separate 30 GB volume at `/home/atoma` and never references the 50 GB one.

**Why:** the root disk is nearly full, so anything large (sources, node_modules, backups) goes on the volume.
**How to apply:** for server-side work on atoma use `~/dev/atoma`; never run a live atoma run from it
(one run at a time, shared quota, see [[push-to-prod-authorized]]); avoid full `npm run check` there
(4 GB host, harness OOM seen before, see [[supervisor-mender-state]]).
