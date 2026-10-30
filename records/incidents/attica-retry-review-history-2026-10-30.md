# A repair review lost the original failing execution

## Demonstrated production failure

Attica run `0c35ed5a-133a-4edd-9682-48fcaea4e8a4` recorded the two requested baseline assertion failures in command event `b79d3bfd-149e-4bf2-8b09-fceba260ba7e`. Later result review `ccafc3ec-dcc4-40a4-9bf2-7767a3523b9e` refused a corrective execution because its report described a passing baseline and did not present the original failing assertions. That passing baseline belonged to a later repair iteration. The original failure remained in the raw run journal, but ordinary supervision handed the next reviewer the latest result witnesses only. A result's internal trace was not a review inventory and aggregation discarded it. Root-remediation command history already addressed a different boundary.

The incident demonstrates missing review access, not missing raw archives or proof that the current implementation was correct. Final-source checks, all assertions and independent artifact verification still decide delivery. The source worker used revision `292c7fa3`; this change does not alter its retained execution history. The source ended partial, and its automatic validation was inconclusive. Independent artifact checks later established the requested listing behavior; a stale hardcoded bundle assertion still prevents a passing application check.

## Change

`superviseLoop` retains host-attested execution references from refused iterations in a separate `Result.historicalEvidenceIds` field. Ordinary aggregates, synthesis landings, holistic/focused root reviews and checkpoint persistence carry these references. Review inventories resolve same-attempt records, label them prior execution context and expose complete recorded command replies and captured redirected logs through the existing read-only archive protocol.

Historical references never enter current `Result.evidence`, browser facts, proof coverage, parent-test consequences, trust checks or tool-credit inputs. Source reads, browser observations, unknown references and other-attempt records are not promoted into this execution history. No review executes a command, changes model selection or obtains automatic approval from an earlier pass. Existing checkpoint archives and their historical-before-restart handling are reused; there is no new schema, store or restored execution credit.

## Regression and adversarial review

The failing regression crosses the actual `superviseLoop`, an attested L1 execution in a new branch and the `llmVerdict` archive-reading protocol. Before the change, the second review inventory contains only the final successful command and cannot read the baseline failure. After the change, it reads the original failing archive while the result's current witnesses contain only the final command.

Additional cases cover an old successful command followed by a current failed command, complete redirected-log reads, duplicate references, unknown and other-attempt references, source reads, restored records and unrelated siblings. A real child-process runner/checkpoint fixture persists a history-only receipt, then a cold continuation reads its complete archive without restoring proof counters or credit. Existing supervision, phase history, evidence reading and synthesis tests are also exercised.

Adversarial mechanism review: merging old witnesses into current evidence would allow command gates and proof counters to reuse an obsolete pass, so that approach is rejected. Scanning the global attestation log would expose unrelated parallel work, so membership comes from each task's refused results. Treating old DOM observations as current would require an unchanged-document binding, so this change does not carry them. Reading a previous successful log cannot establish the latest source state; inventories and returned pages explicitly mark that limitation. Large histories remain paged under the existing context budget rather than copied into every prompt.

## Verification

The targeted six-file suite passed 110 tests, including the cold continuation. After `npm ci`, `release:check:static` passed both TypeScript configurations, lint, audit (zero findings), build, skeleton installations and compiled release/auth/help smokes. The complete 599-file test inventory then passed 8,610 tests with 69 supported skips using four workers.

The first full attempt retained 14 failures: disk exhaustion affected setup, archive writing and a cold continuation, and three browser checks failed or timed out. Their complete log was preserved. Byte-identical immutable proofbook copies were deduplicated with verified hashes, retaining both paths and every archive member; no raw log or application data was removed. The subsequent complete run recovered those errors. Local Docker independently failed to answer a read-only information request within 15 seconds; four owned read-only `docker image inspect` clients were stuck for six to fifteen minutes. Only those clients were terminated, allowing the optional local availability probes to report Docker unavailable. No daemon, container or other agent was signalled. The resulting local skips do not establish container isolation; the required CI worker build/isolation job remains a separate release gate.

No Attica delivery is accepted or published by this platform change.
