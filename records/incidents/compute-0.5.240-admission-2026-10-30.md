# Compute 0.5.240 admission for complete tool results

The owner explicitly approved adding only Compute 0.5.240 to production on
2026-10-30. The installer receipt for revision
`e5f5391c0965346613c59e44a704c7adb94c965c` identifies version 0.5.240 and
content digest `11411f30bffd507ad7448b8d531c2f2b23512dae9cd52f153c232d0afa5ee965`.
It includes the bounded compressed tool-result transport described in
[the oversized-result incident](compute-oversized-tool-result-2026-10-30.md).
The server half was verified active before updating any installed client.

The admission update appends exactly 0.5.240, retaining every existing version,
image restriction and unrelated configuration byte. The original private
configuration was backed up on the production host before an atomic write;
ownership and mode were preserved. An expected SHA-256 guards concurrent edits.
The original configuration digest was
`5b6bab630bec0ffd0a35ea93724d8ed94500a3b3ee5519bc490bfe7e09ee684a` and the
updated digest is
`ba2b352b61a1f2d7b7403092275e887912b4e52b2b96e4dbc5ce58ec7bc905bc`.
No credential contents were printed or exported.

The initial write was rejected by automatic approval review because the earlier
precise consent covered only 0.5.224. It made no change. After the owner approved
0.5.240, a malformed Node invocation also made no change; the corrected stdin
invocation applied the reviewed update and verified both the new file and backup.

This record-only revision activates the approved policy through normal deployment.
Completion still requires checking the loaded policy in the web process and the
selected executor, the three native package jobs, and the installed client's actual
version and execution eligibility. A connected client alone is insufficient.
The first Intel packaging attempt failed while ejecting its temporary DMG device
(`hdiutil: Resource busy`), after tests and application packaging succeeded; its
failure evidence is retained and the failed job is retried on a fresh runner.

The existing Attica application is unchanged: its API returned 1,059 saved listings
and the hashes and modes of all six retained data files matched the prior check
after the server transport deployment. This admission change neither accepts an
Attica delivery nor publishes or updates its hosted application.
