# Compute guided setup review

Scope: OS-specific web onboarding and native Docker preparation. The existing
hosted/client run admission and teardown contracts are unchanged.

- Browser detection is a presentation hint, with explicit override. Mac UA Intel
  is ambiguous; the page asks the user to check About This Mac.
- The renderer accepts no command, path or URL for prerequisite operations.
  Only fixed Docker URLs and native commands are used by the utility process.
- Downloads stream to exclusive private temporary files, with a 2 GiB cap,
  bounded time, cancellation and publisher verification before execution.
  No license acceptance flags or silent installation are used.
- Preparation intent is separate from execution state. Missing prerequisites
  prevent image pulls. Readiness comes from Docker info, not elapsed time.
  Cancellation clears persisted preparation; run commands are never persisted
  or replayed by this feature. Existing unconfirmed-stop behavior is retained.
- A failed launch is not retried in a loop. Polling only resumes pending setup
  when installation appears or the engine reports ready.
- Web setup retains its script-free CSP; pairing keeps its session/origin rules.
- Preview installers stay outside the signed automatic-update feed. Native
  download links are activated only after all platform artifacts are published.

Validation: targeted tests cover selection, WSL version, bounded downloads,
missing/stopped/ready Docker, wrong publisher, preparation restart/cancel, and
HTTP rendering. Electron smoke exercises the new preparation controls using an
isolated fixture, not the owner's live client. The real browser smoke exercises
both setup views, keyboard navigation, small-screen layout and OS overrides.
Real license dialogs, Windows elevation/reboot and clean-machine installation
remain manual platform acceptance tests, as requested by the owner.
