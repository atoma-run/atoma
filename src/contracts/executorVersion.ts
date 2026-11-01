/** Increment before shipping writers/storage/RPC that cannot coexist with the previous generation. */
export const EXECUTOR_COMPATIBILITY = 5; // 5: project rows and traces carry depth 'direct' (2026-11-01), which generation 4's strict depth enum refuses. 4: permission-bearing starting snapshots are rejected by older strict checkpoint and workspace readers.
