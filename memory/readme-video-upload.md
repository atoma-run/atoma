---
name: readme-video-upload
description: How to publish a demo video into the README without the GitHub web UI (gh api upload to user-attachments)
metadata:
  node_type: memory
  type: reference
  originSessionId: b123dd13-2ec7-46dd-adfc-66aefc9b36ba
  modified: 2026-09-26T21:13:26.186Z
---

README videos are GitHub `user-attachments` assets, and they CAN be uploaded from the CLI — do not tell the user it needs a web drag-and-drop:

```
gh api 'https://uploads.github.com/user-attachments/assets?name=<file>.mp4&content_type=video%2Fmp4&repository_id=1213948861' --method POST --input '<path>.mp4' -H 'Content-Type: application/octet-stream' -H 'Accept: application/vnd.github+json'
```

Returns `{"url":"https://github.com/user-attachments/assets/<uuid>"}`; put that bare URL on its own line in README.md ("## Watch the demo"). repository_id 1213948861 = mgtf/atoma. Codex found this on 2026-09-15; reused 2026-09-27 for the demo film rendered by `scripts/demo-film/compose.mjs` (output `screenshots/demo-film/atoma-demo.mp4`, gitignored).

Pushing to main is still blocked by the auto-mode classifier ([Production Deploy]); the user pushes. A denied chained command can still have run its first steps (a `git checkout main` ran before the push was stopped) — verify the branch afterwards.
