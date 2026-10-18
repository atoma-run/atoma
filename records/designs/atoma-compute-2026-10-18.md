# Atoma Compute — implementation record

Owner-approved direction, 2026-10-18: move workspaces, tools, Chromium,
builds/tests, Haystack and ephemeral previews to the customer's computer.
Atoma retains orchestration, model credentials, permissions, budgets, shared
knowledge, traces, verified checkpoint bytes and delivered artifacts.
The owner subsequently excluded the Electron application from this change.

## Implemented execution path

The asynchronous private workspace interface has hosted and remote adapters
using the same business functions. Preparation, seeding, referenced-run copies,
read-only photographs/restoration, routing, inherited checks, deepening,
classification and checkpoint export execute where the files reside. Reference
identities are captured and compared on that same Linux filesystem. These are
internal typed operations, absent from the L1 catalogue.

The outbound authenticated WSS connection negotiates service capabilities and
fences connection, execution and request identities. Browser pairing requires
organisation confirmation and a one-use code bound to the client's secret.
Device ownership, explicit project grants and immutable run targets live in the
product store. Existing projects remain hosted. Revocation is checked on dispatch,
results and heartbeats; no server deadline proves process exit.

The project coordinator dispatches through a private bridge to the existing
host runner. Tool and retrieval channels remain separate from workspace control.
Atoma retains models, accounting, GitHub and connector credentials. Device
admission skips unavailable machines while preserving organisation, model and
orchestration limits. The residual server memory reserve defaults to the hosted
reserve; no global ceiling has been raised.

The separate workspace service owns private snapshots. Tools cannot access its
control or snapshot volumes. After tool drain it remains available for sealing
and export. Checkpoint bytes are streamed into incomplete product-store snapshots,
validated and atomically attached; no SQLite cursor remains held across a network
wait. Deliveries are independently verified before publication. A durable host
journal retains pending finalization; explicit recovery uses a fresh export-only
generation, never replaying tools or model calls. Interrupted execution can use
normal checkpoint recovery only after an exact confirmed stop report.

## Headless client and isolation

`compute pair|doctor|pull|start|status|forget` supplies the native macOS/Windows
headless entry point. Credentials use macOS Keychain or Windows DPAPI CurrentUser.
The launcher alone owns Docker access; workloads use named Linux volumes without
host directory mounts, non-root users, read-only root filesystems and bounded
CPU, RAM and process counts. This Docker Desktop profile is not production gVisor.

The persistent local inventory is exclusively locked and records allocation,
execution generation and the last server-confirmed checkpoint. Lease expiry,
sleep/clock discontinuity and disconnect trigger teardown. Reconnection requires
engine-confirmed absence and reconciliation, refreshes diagnosed capacity, and
never resumes an interrupted execution. CLI controls accept/drain/pause/stop are
wired to the current connection. Status includes resources and bounded transfer
progress. Bulk transfers share an 8 MiB/s limit.

One run plus one preview shares the 5 CPU / 6 GiB envelope. Admission requires
4 GiB free Linux disk; periodic checks stop workloads below a 1 GiB reserve or
when Docker becomes unavailable. This is a free-space guard, not a filesystem
quota. Retained volumes are not automatically deleted to conceal a disk shortage.

## Retrieval and previews

The private retrieval container performs document extraction, indexing,
embeddings and reranking offline. Atoma controls source selection and revalidates
scope and returned citations. A disposable 256 MiB embedding cache is keyed by
organisation, project and model identity; the client receives no product store.
The base image offers BM25; a reproducible derived-image recipe packages already
provisioned, content-pinned models for hybrid search. Model path identities use
portable POSIX separators.

Previews run on a separate local copy. The existing gateway keeps its origin,
claim, generation, terminal-input and expiry policies; a bounded stream replaces
its destination. Only launcher-issued instances can be relayed, through their
fixed container-local port, without published ports or arbitrary destinations.
Disconnect withdraws preview access. Failed stop or server restart never becomes
a fabricated workload-stop receipt. Remote classification is stored only after
artifact validation and is not shared-trust evidence.

Remote provenance follows supervision and tool observations. Positive shared
trust, recipe promotion and prompt learning remain withheld without independent
platform-controlled validation.

## Product and packaging

Project settings expose target selection, explicit grants, machine availability,
revocation and requester-scoped pending-finalization recovery. Errors are
retryable and controls retain the existing keyboard/accessibility surface.
The compiled browser pairing flow requires exact-origin confirmation.

The release builds private workspace, retrieval and preview bundles. Preview
runtime closure excludes control-plane and element modules; shared artifact byte
policy is imported through the minimal contract. The Compute images workflow
builds and tests native Linux amd64/arm64 images and publishes immutable digest
receipts only from releases. Optional staged model weights are excluded from the
ordinary source release archive.

The user/operator contract is [docs/compute.md](../../docs/compute.md).
The [capacity experiment](../experiments/atoma-compute-capacity-protocol-2026-10-18.md)
is preregistered. No resource-saving percentage or production admission increase
is established by implementation tests.

## Validation boundary

Local evidence uses macOS Apple Silicon and Docker Desktop Linux ARM64.
Real containers cover isolation/egress, the private workspace, WSS execution and
export-only recovery, disk exhaustion teardown, BM25 and actual offline hybrid
retrieval, and static/Node/terminal preview relays. Failure tests cover revocation,
double connection, generation changes, lost acknowledgements, partial transfers,
path/link/size/cross-organisation rejection and confirmed-stop reconciliation.
Final release and browser results are recorded in the accompanying review.

Electron, signed installers and their window/background lifecycle are explicitly
out of scope. Native Windows/WSL2 and Mac Intel acceptance, published multiarch
image acceptance and capacity measurements require their corresponding execution
environments; local ARM64 success is not evidence for those platforms. The code
remains opt-in and no production deployment is part of this change.
