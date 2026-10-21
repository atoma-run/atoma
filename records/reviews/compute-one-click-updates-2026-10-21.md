# Compute one-click updates — adversarial review

Owner request: detect available desktop updates and install with one click,
without interrupting an active run. The existing signed-only update policy stays
in force. This change spends no model quota and never starts a project run.

## Mechanisms reviewed

| Scenario | Mechanism and evidence |
| --- | --- |
| Preview or unpackaged application | No update checks or downloads; explicit manual-download explanation. Main-process integration test covers the guard. |
| Same or older release | The existing updater decides availability with downgrades disabled. CI assigns ordered native patch versions; build metadata alone would compare equal. |
| Double click, repeated state events, periodic check | One asynchronous operation at a time; pending installation suppresses periodic checks; installing is terminal. |
| Download fails or signature verification fails | No drain or disconnect before successful download; retry remains available. |
| Run accepted during download | Drain is acknowledged after download, then current allocations and transfers finish naturally. |
| Desktop UI omitted a recently created allocation | `disconnect-idle` rereads the live inventory in the utility process after acknowledged drain. Production controller regression covers stale UI state and an unavailable inventory. |
| Work is allocating, active or unconfirmed | Wait; neither pause nor stop is sent. A stopped inventory entry alone is insufficient when a transfer is still in progress. |
| Docker cannot confirm teardown | No installation. The existing shared application lifecycle must confirm cleanup; regression exercises its failure. |
| Runtime exits | Main retains `stop-unconfirmed`; no installation follows a lost runtime. |
| User resumes admission during update wait | Main rejects accept/connect/prepare from renderer IPC while an update is pending; live idle check independently requires drain. |
| User postpones | No install; downloaded update remains available; admission stays paused until the user's explicit Activity action. |
| Renderer requests another updater action or URL | Closed action schema, sender/frame authorization and fixed feed; no URLs cross update IPC. |

## Release boundary

The desktop workflow includes updater/controller/main-process tests and the real
Electron sandbox/IPC smoke on all three supported native targets. The smoke also
receives update state through the actual preload subscription and checks the
available, downloading and waiting UI without paid runs or actual installation.

Signed publication still needs publisher certificates and macOS notarization.
The server must approve each exact native version through
`ATOMA_COMPUTE_APP_VERSIONS` before signed rollout; no compatibility gate is
bypassed. Earlier preview installations still require a manual upgrade to a
signed build. Actual signed download/install/relaunch cannot be established by
a mocked updater or an unsigned local build.

Local verification: 64 focused tests passed, one platform-specific credential
test skipped; both TypeScript configurations, lint, documentation checks and
desktop bundling passed. Full release execution outside the command sandbox
was rejected by session policy. The native Electron process exited without a
result in that sandbox. CI and native packaging remain required verification.
