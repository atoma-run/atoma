# Witnessed Markdown deliverables

Atoma's worker includes [Wit](https://github.com/zboralski/wit), pinned to
`554cd59de19bf6a31770b14a624e6ca0701ce1a0`. Molecules with `run_shell` can use
it to keep generated tables, example outputs and report values tied to their
source commands. Hosted and Compute runs receive it with the worker image;
existing workers acquire it when replaced by a newly built image.

For a local backend, install the same revision with Go 1.26.3 or newer and
put the resulting binary on the worker process's PATH:

```sh
go install github.com/zboralski/wit/cmd/wit@554cd59de19bf6a31770b14a624e6ca0701ce1a0
```

## Evidence exchanged between agents

Wit also supports evidence handovers, before a final deliverable exists.
Runtime guidance reaches planners, tool-mode executors and reviewers, including
agents loaded from stored types. For computed claims exchanged in Markdown,
the producing molecule binds values, tables or examples to source-derived
commands and checks the final document. Its result names the document, inputs,
commands and observed outcome. Internal evidence stays separate from user
documentation and within the assigned output scope; a handover does not require
creating an extra file in a read-only or reasoning-only phase.

Existing transport receipts carry the actual command exit and output to the
supervisor and, as bounded historical observations, subsequent sequential
agents. Recipients assess the sources and assertions as well as reproduction.
They retain failed checks and later changes rather than turning an agent's
success claim into an observed success. A new recipient does not itself require
re-execution; changed inputs, disputed behavior or unknown freshness do.
Supervisors read the evidence and delegate necessary execution to a molecule;
they never execute Markdown directives themselves.

This is runtime guidance using the existing evidence exchange, not automatic
document generation or an additional acceptance gate. Parent-owned tests and
other required proofs still apply.

## Authoring

Keep the source data and any scripts needed to reproduce the result in the
delivered project. For example, a report beside `summary.mjs` can contain:

````markdown
<!-- wit: node summary.mjs -->
```text
Rows: 12
```
````

The command runs from the Markdown file's directory. Wit captures stdout;
the code fence preserves its language. A Markdown table can instead use a
region ending with `<!-- wit:end -->`. Upstream also supports scalar
`wit:set` / `wit:get` variables for inline values.

Through `run_shell`, invoke `command: "wit"` with
`args: ["generate", "report.md"]`, then `["check", "report.md"]` after the
final changes. These are ordinary shell calls with the existing timeout,
environment filtering and process cleanup. A molecule holding `record_probe`
can use that recorder for the final check when a command receipt is needed.

`check` exits nonzero for `STALE` output or `UNAVAILABLE` evidence. The latter
preserves cached text: it does not establish that the document was reverified.
Generation is atomic per file, not across multiple files. Keep the full
command result in the run evidence; respect the normal reader-facing
documentation rule instead of adding a verification appendix.

## Execution and interpretation

Both modes execute the document's commands, including commands in inherited
documents. Inspect them before invocation. The worker container and its egress
policy remain the isolation boundary; local execution has the same limitations
as any other local `run_shell` command. Wit is not a read-only verifier or a
separate sandbox.

A passing check establishes that the witnessed text matches command output.
It does not prove the command measures the right thing: a constant `echo`
can reproduce an invented claim. Review source relevance and acceptance
criteria normally. A document with no witnesses can also pass. Supervisors
read the result receipts and files; they do not execute Wit directives, and
Wit adds no automatic acceptance or trust credit.

The worker build compiles upstream Go source at the pinned revision and ships
its MIT license at `/usr/local/share/licenses/wit/LICENSE`. No Go toolchain,
network installation or model call is needed to use it during a worker run.

## Platform reporting

Platform administrators can open **Admin → Wit** (`#/wit`) to inspect recorded
checks and generations, their observed exit codes, output excerpts and source
runs. The route `/api/admin/wit` enforces the same platform-admin boundary and
cross-organisation audit as run readers. Opening a report executes no commands.

Each page inspects ten indexed runs, newest first; **Scan older runs** advances
the cursor and **Latest runs / refresh** returns to the current page. Counts
apply only to that page. The reader examines the last 2,000 events per run,
skips individual events above 256 KiB, and keeps the newest 50 matching calls
per run. Unreadable runs and omitted events are explicitly counted. Output
excerpts are capped at 2,000 characters; the source run retains the receipt.

Only direct `wit check` / `wit generate` calls through `run_shell` or
`record_probe` are recognized, including simple command-line forms. Shell
composition, wrapper scripts and indirect invocations are not interpreted.
A zero exit is reported separately for checks and generation; absent exit
status stays unknown. A successful check may contain no witnesses and says
nothing about later changes to the document or the correctness of its sources.
