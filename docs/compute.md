# Atoma Compute

Atoma Compute runs tools, the Linux workspace, Chromium, builds, tests, document
extraction, Haystack and temporary previews on a paired computer. Atoma retains
orchestration, models, credentials, permissions, accounting, the shared catalogue,
verified checkpoints and delivered files. Hosted execution is reserved for platform administrators. Other members must
connect a computer and explicitly select it for each project before starting runs.
Legacy hosted targets remain readable but cannot launch work for ordinary members.
Permanent application hosting is a separate service.

## Headless client

Start with **Connect a computer** in the Atoma welcome conversation or project
settings. `/compute/setup` provides the compiled client download, SHA-256 verification,
platform-specific pairing commands and the steps to select a machine for a project.
Pairing alone grants no project access. The setup step reports connected and disconnected computers; existing deliveries remain accessible during setup.

The client requires the repository's pinned Node 24 release and Docker Desktop.
Use the native Windows Node installation with Docker Desktop's WSL2 backend;
run the client in macOS Terminal or Windows PowerShell. The desktop graphical
application is outside this implementation.

Install the release's Node dependencies with `npm ci --omit=dev`. From its root,
pair using the immutable image references supplied by the Atoma operator:

```sh
npm run compute -- pair --server https://atoma.run --name "My computer" \
  --workspace-image REGISTRY/workspace@sha256:DIGEST \
  --worker-image REGISTRY/worker@sha256:DIGEST \
  --retrieval-image REGISTRY/retrieval@sha256:DIGEST \
  --preview-image REGISTRY/preview@sha256:DIGEST
npm run compute -- pull
npm run compute -- doctor
npm run compute -- start
```

Use one line for the pairing command in PowerShell. Replace each placeholder
with its actual reference; mutable tags are refused. The image architecture must
match the computer. Pairing prints an HTTPS browser link: sign in and confirm
the organisation. Its one-use code is bound to a secret held by the client.
Credentials are saved in macOS Keychain or Windows DPAPI CurrentUser storage.

In the project's settings, explicitly allow the machine to access that project,
then select it as the execution target. Each run keeps its original target even
if the project setting changes. Waiting states explain disconnection, occupancy,
resource shortage, incompatible versions or removed access.

`start` accepts these commands:

- `status`: allocations, the last server-confirmed checkpoint, transfer byte/file
  counts, available Linux disk and workload CPU/RAM/process usage.
- `drain`: refuse new runs while current work continues.
- `accept`: accept new runs again.
- `pause`: request suspension at the next approved sequential phase boundary.
- `stop`: request cancellation; the acknowledgement is not proof of process exit.

Ctrl+C stops workloads and exits. The client remains attached to this terminal;
closing it is not a background application workflow. `compute status` in another
terminal reads the durable allocation journal and current Docker workload usage.
`compute forget` removes the local credential only when the client is not running;
revoke the machine in Atoma as well to withdraw its server-side access.

## Isolation and resources

One run and one preview share a declared envelope of 5 CPUs and 6 GiB RAM.
Admission requires at least 4 GiB free Linux disk. During work a periodic check
stops the connection if less than 1 GiB remains or Docker becomes unavailable.
This is a free-space guard, not a filesystem quota. Docker settings are never
changed automatically. Retained run volumes remain available for recovery;
insufficient space refuses subsequent allocations rather than deleting evidence.

The launcher alone has Docker access. Workspaces are named Linux volumes; no
home directory or arbitrary repository is mounted. Workloads are non-root,
non-privileged, have read-only root filesystems and CPU/RAM/process limits.
The workspace control service and retrieval corpus/cache have separate volumes.
The desktop profile uses Docker's standard runtime and is not equivalent to
production gVisor isolation.

Tool networking uses the existing isolated package-registry proxy policy.
Pair with `--no-network` to disable it. Retrieval runs without network access;
hybrid embeddings and reranking require an operator-provisioned retrieval image
containing pinned offline models. The embedding cache is disposable, limited to
256 MiB and keyed by organisation, project and model identity. It contains no
product database. Bulk workspace and corpus transfers share an 8 MiB/s budget;
heartbeats, commands and previews have independent channels.

## Disconnection and recovery

An outbound WSS connection needs no incoming port or router configuration.
Compute automatically reconnects after a brief Wi-Fi or network change while
both processes and the existing 30-second heartbeat lease remain alive. A
silently stale TCP connection is replaced after 10 seconds without a heartbeat
reply. Reconnection reauthenticates the same device, machine and session and
rechecks project access; it does not renew the lease or allocate another run.

The two peers retain bounded sequence and acknowledgement state in memory.
Unacknowledged messages may be retransmitted, but are deduplicated before
command execution, including commands still running when the network changed.
An explicit stop, an expired lease, a process restart or revoked access remains
terminal. Loss beyond the lease triggers workload teardown; a longer run budget
does not extend that connection lease. Only engine-confirmed teardown permits a
fresh connection to reconcile an interrupted execution. Without an eligible
confirmed checkpoint, that new connection cannot resume its work.

This transport extension requires updated Compute and server versions. Older
peers retain the previous fail-closed behavior. It is not a run-restart feature.

After reconnecting the computer, use **Reconcile and finish transfer** in the
project's Compute settings for a pending run. A completed run can export its
remaining files in a fresh, export-only generation. An interrupted execution
must first have its stop confirmed. Atoma then closes that interrupted run
automatically instead of leaving it live. It is marked failed unless a cancellation
was requested; normal checkpoint eligibility decides whether continuation is possible. Otherwise, start a new run. Checkpoints and
files received incompletely cannot be published. Saved deliverables remain
readable while the computer is offline.

Previews use a separate local copy and retain the gateway's origins, permissions,
generations and expiry. The relay can connect only to a launcher-issued preview,
never to a caller-selected local URL or port. Disconnecting makes the preview
unavailable. Restarting the Atoma server never asserts that a client workload
has stopped.

## Connection diagnostics

Compute keeps connection events in `~/.atoma/compute/connection.log` on the
computer, rotating the previous file to `connection.log.1` at 1 MiB. Server events
use the `[atoma compute]` prefix in the executor journal. Match device/session
identities and connection/execution generations across the two logs.

Events distinguish socket closure, transport errors, handshake and request
timeouts, expired heartbeats, rejected frames and local shutdown. They include
pending request ids and methods, heartbeat age and buffered byte counts. A
separate local event records whether workload cleanup was confirmed. Credentials,
file contents, command arguments, exception messages and remote close text are
excluded. Historical closures cannot acquire diagnostics retroactively; desktop
logging requires a Compute version containing this change.

## Operator activation

Activation is opt-in through `ATOMA_COMPUTE_ENABLED=1`, with explicit comma-separated
`ATOMA_COMPUTE_APP_VERSIONS` and `ATOMA_COMPUTE_IMAGE_DIGESTS` allowlists. The latter
admits the worker content digest reported by the client. Authenticated HTTPS
project hosting and the existing trusted-proxy configuration are required.
Route WSS upgrades for `/compute/v1` through the same public origin.

`ATOMA_COMPUTE_HAYSTACK_CONFIG` selects the client retrieval runtime/model
identities; when absent, `ATOMA_HAYSTACK_CONFIG` is reused. Its runtime identity
must match the retrieval image, not a different server Python installation.
The published receipt includes a ready-to-use `haystackConfig` value for this
environment variable; use the receipt matching the device architecture.
When admitted devices use different runtime releases, preserve that legacy
setting and set `ATOMA_COMPUTE_HAYSTACK_CONFIG_BY_DEVICE` to a JSON object whose
keys are device UUIDs and whose values are the matching published
`haystackConfig` objects. The immutable run target selects an exact device
entry. An unmatched device keeps the existing Compute setting, or the server
setting when the Compute setting is absent. Hosted runs do not read this map.
The entire configured map is validated and bounded to 64 KiB; invalid entries
refuse Compute launch rather than silently falling back. Only the selected
configuration reaches the host run process; the device map stays on the host.

Client model paths are fixed at `/models/embedding` and `/models/reranker`.
Provider keys, GitHub credentials and customer MCP credentials stay on Atoma.

The residual host reserve `ATOMA_COMPUTE_HOST_MEMORY_RESERVE_MB` defaults to the
hosted reserve. Organisation, model and orchestration admission limits still
apply. Do not increase the global ceiling until the registered capacity
experiment has measured residual host consumption. Remote observations do not
automatically earn positive shared trust or promote catalogue recipes.

## Image packaging

The **Compute images** workflow builds and tests Linux amd64 and arm64 images on
native runners. Manual dispatch validates without publishing. The release workflow calls it
after publishing the source archive; it uploads the tested images to GHCR and adds an architecture-specific JSON receipt
and checksum to that release. Pair using its `reference` values; the server worker
allowlist uses the digest after `@` in the receipt's worker `reference` (the manifest identity reported by the client), not `contentDigest` (the image configuration identity). For an image-only publication, push an explicit `compute-images-*` tag at the
verified revision. This publishes the same four images without releasing or
deploying the application; the workflow retains digest receipts as artifacts.
Native Linux validation does
not replace macOS Docker Desktop or Windows/WSL2 acceptance.

[Published retrieval images](../records/releases/compute-multilingual-2026-10-18/README.md) include pinned multilingual E5-small embeddings and
mMARCO MiniLMv2 reranking models. They support hybrid search offline across all
13 Atoma locales (ar, bn, de, en, es, fr, hi, id, ja, pt, ru, ur, zh), including
queries and documents in different languages. This is language coverage, not a
claim of equal retrieval quality in each language. BM25 remains selectable.
Models, source revisions, checksums and licenses are recorded in
`docker/compute-models.lock.json`; the image retains model cards and licenses.
The build downloads weights, but runtime execution cannot access the network.
E5 uses `query: ` for questions and `passage: ` for documents; both prefixes
must match the model receipt. Document prefix changes invalidate cached vectors.

To reproduce the distributed models after `npm run build`:

```sh
python3 scripts/download-compute-models.py
node scripts/build-compute-models.mjs --embedding dist/compute-model-downloads/embedding \
  --reranker dist/compute-model-downloads/reranker --query-prefix 'query: ' --document-prefix 'passage: '
```

To build a custom hybrid image from already provisioned local models:

```sh
node scripts/build-compute-models.mjs --embedding /absolute/models/embedding \
  --reranker /absolute/models/reranker --query-prefix 'MODEL_SPECIFIC_PREFIX'
docker build -f docker/compute-retrieval-models.Dockerfile \
  --build-arg RETRIEVAL_IMAGE=REGISTRY/retrieval@sha256:DIGEST \
  -t YOUR_HYBRID_IMAGE .
```

The helper verifies content pins before and after copying, excludes download
metadata and never downloads weights. The image contains `/models/models.json`
with the two content revisions and query prefix. Publish and pin this derived
image as well; `doctor` reports its Python runtime identity for the host's
`ATOMA_COMPUTE_HAYSTACK_CONFIG`.
