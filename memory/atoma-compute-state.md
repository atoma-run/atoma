# Atoma Compute implementation state — 2026-10-18

The owner requested the whole customer-compute plan. It is NOT complete and
there is no usable customer-device target or desktop application yet.

Work is isolated on `codex/atoma-compute`, in the managed worktree
`/Users/mgtf/.codex/worktrees/atoma-compute/atoma`. Do not deploy this as a
finished feature. The main/shared checkout has unrelated ongoing work.

Implemented: async workspace capability integrated into the runner's live
control operations; local adapter and private process RPC; standalone compiled
workspace service/image; remote sequential checkpoint sealing after process
drain, bounded private export, chunk receiver, validation and atomic owner-bound
attachment with expiring transfer reservations. Default execution remains hosted.

Remaining dependencies and capacity protocol are recorded in
`records/designs/atoma-compute-2026-10-18.md` and
`records/experiments/atoma-compute-capacity-protocol-2026-10-18.md`.
Startup/seed/restore/deepening/final export still use host files. Device pairing,
WSS, generations/leases, authorization/admission, remote tool transport,
retrieval/previews, customer-proof trust policy and the Electron app remain.

Docker Desktop/Linux ARM64 is available. The workspace service was built from
packaged dist and tested under the isolated `atoma-workspace:compute-development`
tag; snapshot spool uses a separate control volume never given to tools.
No macOS signing identity was installed. Windows/Mac x64 acceptance and signed
distribution are unverified. No resource reduction has been measured.
