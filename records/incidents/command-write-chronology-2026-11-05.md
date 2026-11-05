# Passing command receipts lost their subsequent-write context

Attica run `f9358f1a-a6d1-4911-9ad2-88fe2f372cdc` exposed a result-review error:
commands passed, then the molecule changed the collector, normalizer and tests
without rerunning verification. Its report accurately said that verification
was unfinished. Review `2eb98854-7be6-4171-acd0-2b2ae87902cb` instead requested a
report-only correction saying final verification had succeeded. The tool-free
correction repeated that claim. Later execution of the new tests failed,
confirming that the earlier receipts did not establish the revised tests.

The evidence renderer retained the latest receipt for each command and branch,
but bounded presentation could omit the writes after it. Its general historical
context warning did not make this particular chronology explicit. A new read of
the current assertions established their contents, not their execution.

The repair records up to six distinct later attested write/edit paths on shell
witnesses, with the omitted count. The existing review renderer displays those
facts beside the associated receipt, preserving its command and actual exit
status. This introduces no model call, execution, guessed dependency graph,
workspace fingerprint or automatic refusal. It does not classify shell effects,
interpret writes in another branch, or require rerunning checks after unrelated
changes. Legacy absence remains unknown. Full tool archives stay unchanged.

The regression crosses the production attesting executor, molecule result
construction and model-review presentation. It observes a successful command
followed by source and test edits, then checks that the review sees those later
writes. The previous implementation fails that assertion. Countercases cover a
successful rerun, unrelated documentation edits, separate branches, shell effects,
refused/no-op edits, bounded distinct paths and presentation pressure.

The source application remained unaccepted and undeployed during investigation.
Independent testing also identified a separate collector regression involving
real archived property URLs; command chronology does not decide that semantic
question or substitute for checking the delivered application.
