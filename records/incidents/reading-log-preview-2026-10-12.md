# Static HTTP evidence selected a browser script as a Node preview

Production run `fb84de15-8a46-474c-a72a-10afdb7fd8e5` delivered the Reading
log app. Opening its preview started `node app.js`, then failed with
`readiness-timeout` after 65 seconds (03:54:12–03:55:17 UTC). The delivered
`app.js` uses `window` and the DOM; it is not a server.

The inherited manifest contained one HTTP observation of `/index.html`,
without an entry stamp. The original trace, run
`76a9486c-9255-417c-87e9-11f1db991a0e`, event
`48532582-1653-49c0-9dd8-625986dd3dc5`, recorded `servedBy.kind: static`.
`fetch_url record:true` discarded that kind when persisting the probe.
The classifier treated any HTTP entry as Node evidence and selected the
conventional `app.js` fallback. The many browser checks did not override it.

The recorder now persists `serverKind` alongside the optional Node entry,
using the same live-port and non-redirect attribution as `servedBy`.
Classification excludes explicitly static HTTP observations from Node
evidence. Unknown historical probes keep their prior interpretation.
The shared HTTP schema supplies the writer type; the stamp is not taught to
models. No command, model description or source-code heuristic is used to
guess the application kind.

Adversarial review covered mixed static/Node observations in either order,
unknown older observations, conflicting static/entry stamps, missing HTML,
foreign origins, dead process registrations and redirects. Static observations
cannot mask other Node evidence. The existing deleted-server/renamed-server
cases remain unchanged. A regression starts a real static server, records an
HTTP request through the production tool and classifies the resulting files.

The affected historical descriptor required an explicit operator repair:
the workspace and manifest were not rewritten. Before replacing only its
`kind: node, entry: app.js` with `kind: static, entry: null`, the operator
saved a SQLite backup, original descriptor/instance, manifest and evidence
references under production state
`preview-repairs/20261012T035937Z-fb84de15-8a46-474c-a72a-10afdb7fd8e5/`.
The immutable-update trigger and generation counter were preserved; there is
no request-time backfill. Generation 2 became ready at 03:59:46 UTC, and the
existing Chrome tab rendered the Reading log form and filters.
