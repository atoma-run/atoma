/** Increment before shipping writers/storage/RPC that cannot coexist with the previous generation. */
export const EXECUTOR_COMPATIBILITY = 3; // Explicit Compute retries require attempt fencing and separate evidence directories; older executors cannot claim them safely.
