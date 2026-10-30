# Compute 0.5.247 admission for connection recovery

The owner explicitly approved adding only Compute 0.5.247 on 2026-10-30.
The official installer is built from revision
`f022909da24ad92965457b3bf47fed359b1ce8e7`, whose CI, production deployment
and all three native packaging jobs succeeded. The active server revision was
verified before updating the client. The macOS ARM64 ZIP SHA-256 is
`4494b55115ed53221aecd2572c659d361a316b3b91f7a0bc2e19f811520220ce`;
its bundle version, identity and deep strict code signature were checked.

The fix retries an initial handshake timeout only before authenticated readiness
and after engine-confirmed cleanup. Real TLS regressions cover a stalled upgrade,
a missing ready response, unconfirmed cleanup and an already authenticated session.
The existing five-second client deadline owns the initial handshake; the competing
WebSocket timer was removed. TLS, identity and protocol failures remain terminal.
No command replay, lease extension or image policy change is involved.
The complete release check passed: 8,699 tests passed and 45 were skipped.

The production policy update appends only 0.5.247, retaining all existing versions,
image restrictions and unrelated configuration bytes. An expected digest guards
concurrent modification. The original file was backed up before an atomic write,
and both files were checked with ownership and mode 0640 retained. Before SHA-256:
`ba2b352b61a1f2d7b7403092275e887912b4e52b2b96e4dbc5ce58ec7bc905bc`.
After SHA-256:
`40460ee10df81cf7454bb019f544bff69a4c6861d249cbcaa7defef722e6a426`.
No credential contents were printed or exported. This record-only deployment
activates that approved policy through the normal release pipeline.

The Attica price-sort run c2b37c20 and its independent comparison a9eccd4b
finished before this activation; they used installed Compute 0.5.240.
Their full evidence was read and preserved. They do not prove the new client's
production behavior. Verify the installed version, connection and execution
eligibility after activation. No Attica delivery is accepted or published by
this change. The existing hosted application's 1,059 listings are retained.
