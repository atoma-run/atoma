/** Increment before shipping writers/storage/RPC that cannot coexist with the previous generation. */
export const EXECUTOR_COMPATIBILITY = 2; // Initial-state snapshots must survive checkpoint GC; older executors do not retain those references.
