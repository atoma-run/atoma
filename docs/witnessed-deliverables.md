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
