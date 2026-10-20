# Suite contract context — 2026-10-20

## Observed failure

Attica run cd21eff5-a076-46dc-907c-ced5a39c977b authored suite d04115c5ad91abaa
in plan ee4aa2fc-bbc0-4486-a7a2-fe4d8e13f654. It read `row.id` from normalized
rows and treated CSV column zero as the identifier. The observed collector
header was `source,url,identifiant,...`; the resulting assertion later compared
`xe.gr` with `101`. This is evidence against the test's positional assumption,
not evidence that the collector lost identifiers.

Review f6fcc03e-9086-4c2e-aaaf-0c6d45474392 approved the suite. Its current-source
block contained only the 362-character CommonJS entrypoint forwarding to
`../dist/browser/control-server.js`. The compiled implementation had already
been read in the same trace at 13:55:11 UTC, before this review at 14:10:08 UTC.
The host's direct-import-only source selection hid that implementation from the
review. The earlier 1bf32e71 run additionally demonstrates why source alone is
not a verdict: a reviewer overlooked an observed method-before-route guard.

## Change and limits

The existing review facts now follow literal relative module dependencies,
including CommonJS forwarders into compiled output. They reuse the existing
module parser and resolution candidate order. Direct imports retain priority;
the six-source-file cap, existing character budget and observation-only access
remain. Reads are cached within this one review so discovery and rendering do
not read each source twice. No module is executed, no absent build is inferred,
and no dependency leaves the suite's copied cwd. Unavailable or bounded content
is disclosed without inventing an interface or absence.

The shared planning/review guidance now asks for a basis in observed contracts
or an explicit requested change for fields, export columns and statuses. A
negative request must satisfy independent earlier guards or test that earlier
guard intentionally. This changes neither status codes nor the suite execution
verdict. It adds no model call, dispute routing, alias detector or new refusal
gate. Requested interface changes may still have failing regressions before
implementation.

## Adversarial checks

The regression first failed because only the forwarder reached review. It now
passes through real sandbox reads, the actual L3 review request and the parent
runner's subprocess: three wrong field/column/method assertions fail, and their
contract-correct counterparts pass without changing the application fixture.
The reads still grant no blind-overwrite permission. Additional controls cover
cycles, missing dependencies, TypeScript resolution, direct-import priority,
cwd escape prevention and the six-read cap.

Existing tests retain the missing-required-argument/method incident, the late
validation-before-browser branch, test-file and read-run import checks, module
reach, unavailable reads and root replan feedback. These mechanisms must remain
separate: a suite dispute still supplies no model-facing signal or routing.

A proposed replay containing a full production prompt was refused by automatic
approval review for sensitive-data exposure; it was not executed or retried.
The alternative uses authored synthetic module contracts only. Its first bad
suite was refused for all three concrete contract mismatches. One initial
positive fixture was refused because it omitted the requested regression file
from outputs; that fixture was repaired, without weakening the runtime rule.
The synthetic checks are diagnostic examples, not a reliability benchmark.

With the synthetic fixture's outputs corrected, the model approved both the
observed-contract assertions and an explicitly requested identifier-field
change. One positive response nevertheless marked independentWork=true while
its reason said the change was inseparable; the existing mechanical fan-out
check would refuse that response. These samples therefore establish only the
contract-reading examples, not end-to-end executable approvals or a success
rate. No attempt was made to override that independent classification guard.

Validation: 147 targeted tests passed; both TypeScript configurations, focused
ESLint, documentation checks and the full build passed. Full release checks
remain the CI gate before production activation and any dependent live run.
