# CLI preview

Owner decision, 2026-10-08: a customer must be able to test a delivered CLI
inside Atoma without adding a web interface to the project.

Open **Latest delivered results** or a delivered run and choose **Test in
terminal** when its delivery has no web preview. The terminal provides Node.js, bash, a real PTY, interactive
stdin, Ctrl+C, terminal resizing and command exit status in the prompt.
**Import test file** writes a file of at most 1 MiB into the initial working
directory. Shell commands can edit inputs, run tests and inspect outputs.
**Restart** recreates the entire preview from the delivered bytes.

Projects have a **Preview app** tab between Runs and Files. It opens the latest
delivered version inside the project; CLI deliveries open the terminal there.
Leaving the tab closes its browser session and heartbeat.

One generation has one shared terminal and writable workspace. Members of the
same project opening it see the same session; the preview chrome states this.
It is a temporary testing environment, not a deployment or persistent editor.
Shell exit requires Restart. Closing the panel stops its heartbeat; idle and
hard expiry retain the ordinary preview bounds.

## Capability and compatibility

`POST .../preview/open` and `atoma_run_preview` accept `mode: terminal`.
Only organisation members or above may open it, and the run must be delivered.
`terminalAvailable` is a read-only capability, separate from the immutable
web-delivery descriptor. Older CLI deliveries work without a new run or a
rewrite of delivery evidence. A ready generation must be stopped before
switching between app and terminal modes; restart preserves its mode.

The runtime supports the binaries installed in the preview image. Delivered
Node dependencies are copied with the workspace; npm does not install them
when the preview opens. Python is included for the PTY bridge. Other runtimes
and native build toolchains are not promised.

## Execution boundary

The launcher keeps its closed profile API. The terminal variant takes no
command, image, mount path or environment map from the browser. It starts
`node /opt/atoma-terminal/server.mjs` under production gVisor, with a read-only
root, non-root identity, dropped capabilities and bounded CPU/processes.

The filtered delivered copy is mounted read-only at `/workspace`. The service
copies it into `/data/workspace`, on a 512 MiB tmpfs, with memory and swap both
capped at 1 GiB. CLI executables may run from that tmpfs; `/tmp` remains
noexec. All test edits disappear at teardown. The original workspace, stores,
credentials and Docker socket are absent. The terminal has no external egress
proxy, and its browser CSP allows no external resource hosts.

The existing generation origin, one-time claims and grant cookies gate every
HTTP request. Input, resizing and uploads require an exact preview Origin and
`X-Atoma-Terminal: 1`; requests with foreign/missing origins are refused at the
gateway. Output uses bounded polling so grant expiry is rechecked rather than
being bypassed by a long-lived connection. The service retains 1 MiB of output
and reports truncation. Keystrokes are not automatically retried after an
uncertain response. Terminal escapes never acquire clipboard or link-opening
permissions. No command/output transcript enters the platform journal.

## Packaging and validation

`npm run build` packages the standalone runtime, PTY bridge, terminal assets
and catalog-derived labels into `dist/preview-terminal`. `npm run build:preview`
consumes that directory; `npm run build:preview:dev` prepares it first. The
image contains this dedicated runtime, not the worker or control-plane code.
Deployments must rebuild/publish the preview image and update its configured
digest along with the server; an older image does not contain the terminal.

Compiled PTY tests exercise real processes, CLI arguments, stdin, Ctrl+C and
file edits. Gateway tests exercise credential and Origin refusal over HTTP.
Container tests use the production launcher and prove readonly source,
closed network and teardown. gVisor proof requires the dedicated runtime job;
a developer's explicitly requested runc test proves plumbing only.
`npm run preview:smoke:terminal` drives Chrome through the real gateway and
iframe policy to verify commands, uploads, Ctrl+C and a narrow viewport.
