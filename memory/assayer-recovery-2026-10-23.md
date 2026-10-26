# Assayer production recovery — 2026-10-23

Owner authorized fixes, deployment, invalid-attempt retries, VIZ monitoring and
MCP read exposure. First fix 92b224b9 deployed; follow-up 22067885 deployed and verified: it keeps draining
executor work visible after compatible deployment. CI, desktop, security and
deploy all passed; production selected 22067885 while health correctly reported
the active second assay owned by caaa3356. Fourteen surfaces remain, including
that active assay.

Before correction: 36 reports / 116 arms all failed at startup because host
ATOMA_HAYSTACK_CONFIG leaked into ordinary operator runs. Invalid comparisons
were incorrectly marked not-reached and closed their recipe surface. Complete
filtered launch env now isolates the copies; invalid attempts have no judgement,
remain pending, preserve evidence and use the resident failure pause. The
existing tenant authority guard and retirement rule remain intact.

All 15 current recipe surfaces reopened automatically. First completed retry:
repair-isolated-browser-contract-test, 14:16:54–14:40:02 UTC, four delivered arms,
99 calls, one matched case with runtime match/inject/success, neutral/keep,
zero retirements. The next recipe verify-clean-copy-node-tests began
independently after a product run released the slot. The remaining queue runs
under the existing idle/lease/preemption rules; do not force a second run or
restore obsolete recipe revisions.

Use VIZ → Sentinel → Assayer. MCP platform-only: atoma_assayer_health,
atoma_assays_list (nextBefore) and atoma_assay_show (record/log/trace,
nextOffset). Page evidence to the end. Large trace events are explicitly omitted;
read call counts from arm stats, not visible event counts. SDK calls against the
same configured https://atoma.run/mcp verified the new tools before this chat's
native tool catalogue refreshed. Authentication comes from the existing configured
headers helper, never copied tokens.

Task-context limit: historical cases can depend on the original repository,
which is absent from fresh assay workspaces. The first comparison establishes
execution and recipe use, not a measured quality gain on that original project.

Evidence and full reproduction:
[incident](../records/incidents/assayer-recovery-2026-10-23.md),
[MCP proof](../records/incidents/assayer-recovery-2026-10-23-proof.json).

## Follow-up cohort complete (2026-10-24 Athens)

All 14 exact follow-up surfaces completed by 2026-10-23 21:57 UTC. Evidence and rendered report: `records/incidents/assayer-followup-2026-10-23.json` and `.html`. 19 paired cases / 38 arms / 1,045 LLM calls / $25.0206 recorded cost; 232 trace pages read. Six target recipes injected across eight cases. Verdicts: 1 helpful, 2 harmful, 3 neutral, 8 not-reached; all 14 keep decisions applied in journal, zero retirements.

Critical limitation confirmed by reading all four helpful-recipe arm logs: `correct-docs-from-verified-artifacts` counted 2 versus 1 deliveries, but all arms lacked the required report and previous-phase evidence; no requested report append happened. The delivered treatment result explicitly says phase NOT executed. Thus the helpful verdict does not prove task-quality gain. Empty replay workspaces and inconsistent acceptance remain a measurement defect; no further paid retry, manual retirement, service restart, or fix was performed in the monitoring task. Monitoring automation paused after final evidence/report preparation. Additional repair-isolated-browser-contract-test surface bbc04cd9c373 was outside this cohort.
