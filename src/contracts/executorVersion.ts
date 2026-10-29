/** Increment before shipping writers/storage/RPC that cannot coexist with the previous generation. */
export const EXECUTOR_COMPATIBILITY = 4; // Permission-bearing starting snapshots are rejected by older strict checkpoint and workspace readers.
