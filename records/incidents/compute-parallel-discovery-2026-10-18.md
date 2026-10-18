# Parallel discovery closed the Compute workspace connection

Run `a58328d2-18b6-4bf3-9aa0-cbc910e1ec5a`, revision `a0c4703c`, reached
orchestration on the customer Mac, then lost its Compute connection at
19:34:45 UTC. The launcher subsequently confirmed workload stop. No checkpoint
had been sealed. The generic trace text attributed cancellation to a signal;
it was not evidence of a user clicking Stop.

The root plan requested two concurrent read-only discovery branches. The first
cell dispatched its molecule directly after prefiltering; the second produced
a plan whose approval was the last trace event. Each root branch opened its
own read-only guard. The private workspace service intentionally admits only
one guard over the shared filesystem: the second opening throws
`A read-only workspace phase is already active`. The desktop client closes
the connection on a failed workspace operation; the host then aborts the
runner and the launcher stops its workloads. This matches the recorded
dispatch sequence and interruption, although the old transport did not save
the exact close reason.

The approximately 60-second retrieval failure was a consequence of teardown,
not proof of a retrieval timeout. Isolated real WSS/Docker checks with the
distributed image digests and Attica's 113-document corpus remained connected
past that interval. BM25 completed; the hybrid index was still processing when
the diagnostic test's own three-minute limit expired. These checks did not
establish successful completion of hybrid indexing.

## Fix and regression

L3 discovery now owns a single workspace guard around the complete fan-out
and join. Descendants keep their read-only task mark, but do not open another
guard. The existing dispatch waits for all branches to settle, including
rejections, before the outer restoration runs. Implementation starts only
after restoration. Ordinary sequential phase guards remain unchanged.

The regression runs the real L3/L2/L1 supervision with simulated models and a
separate workspace service process. Before the fix, one branch passed and two
failed with the exact overlapping-guard error. After the fix, both pass; the
test also verifies concurrent execution, one restoration, restored seed bytes
before replanning, preserved implementation writes, and contextual discovery
criteria. Existing restoration-on-throw and sequential-phase tests remain.

Adversarial checks: do not serialize independent discovery, weaken the service's
overlap refusal, restore while siblings are active, remove the read-only task
mark, or treat discovery as a resumable checkpoint prefix. The common guard
also avoids hosted branches restoring over a sibling's live work.

The interrupted production run was reconciled through the existing project
settings action after engine-confirmed stop. It is failed, not still running;
no command or model call was replayed. A new run is required because no complete
checkpoint exists. The correction is in host orchestration and needs no new
desktop installer or Docker image.
