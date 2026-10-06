/**
 * Run actors — the names a trace records for LLM calls the RUN makes on its
 * own behalf, outside any agent type. None of them is a row of `atom_types`:
 * no ordinal, no version, no stored prompt, no trust counters. Their tier is
 * the rank the call speaks for in the hierarchy, not the model it ran on —
 * `run-root` judges at the top of the run on the L1 (files) or L2 (text) pin.
 *
 * One definition, imported by the call sites that write these names and by
 * the readers that must tell them apart from agent types (the visualizer's
 * agent detail, the Jev calibration readers). A name recorded here is a wire
 * value in persisted traces: never rename one.
 */
export const RUN_ACTORS = {
  /** Root delivery acceptance: the run's final verdict on what it delivers. */
  root: { name: 'run-root', tier: 3 },
  /** Focused, report-blind review of the acceptance criteria during root acceptance. */
  criteria: { name: 'run-criteria', tier: 3 },
  /** An independent answer a text delivery is compared against during root acceptance. */
  textReference: { name: 'run-text-reference', tier: 2 },
  /** Drafts the acceptance checklist once per run, before the first attempt. */
  checklist: { name: 'run-checklist', tier: 1 },
  /** Picks the top-level tissue the run enters through. */
  router: { name: 'run-router', tier: 1 },
  /** Writes a new platform tissue when the router finds none that fits. */
  tissueAuthor: { name: 'platform-tissue-author', tier: 3 },
} as const;

export type RunActorKey = keyof typeof RUN_ACTORS;

const BY_NAME: ReadonlyMap<string, RunActorKey> = new Map(
  (Object.keys(RUN_ACTORS) as RunActorKey[]).map((key) => [RUN_ACTORS[key].name, key])
);

/** The run actor a recorded name designates, or undefined for an agent type. */
export function runActorKey(name: string | undefined): RunActorKey | undefined {
  return name === undefined ? undefined : BY_NAME.get(name);
}
