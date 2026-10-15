/**
 * How long one shell command may run, and how long the host waits for a tool
 * call that crosses into a container worker. One file because the two must
 * agree: the tools (`src/tools/builtin.ts`) apply the command limits inside
 * the worker, and both worker clients (`src/launcher/localWorker.ts`,
 * `remoteWorker.ts`) bound the call from the host.
 *
 * A run_shell call defaults to 30 s, a record_probe call to 120 s, and either
 * may ask for up to five minutes with `timeoutMs` (2026-10-15: three Attica
 * runs lost paced suites at 30 s). The host bound was a flat 120 s, so the
 * first run after that change, 90ad4303, saw a 120 s probe abandoned by the
 * host at the instant the worker would have recorded it, and any longer limit
 * was capped at 120 s in a container. The host now waits for the command's own
 * limit plus a grace, and keeps 120 s for every other tool.
 */
export const SHELL_TIMEOUT_MS = 30_000;
export const PROBE_TIMEOUT_MS = 120_000;
export const SHELL_TIMEOUT_MAX_MS = 300_000;
export const WORKER_CALL_TIMEOUT_MS = 120_000;
/** Time for the worker to kill the process group and send its answer back. */
export const WORKER_CALL_GRACE_MS = 15_000;

const COMMAND_TOOL_DEFAULTS: Readonly<Record<string, number>> = { run_shell: SHELL_TIMEOUT_MS, record_probe: PROBE_TIMEOUT_MS };

/** The command's own limit for a valid request, or its tool's default; the tool itself refuses invalid ones. */
function commandLimitMs(name: string, args: Readonly<Record<string, unknown>>): number | undefined {
  const fallback = COMMAND_TOOL_DEFAULTS[name];
  if (fallback === undefined) return undefined;
  const requested = args['timeoutMs'];
  return typeof requested === 'number' && Number.isInteger(requested) && requested >= 1 && requested <= SHELL_TIMEOUT_MAX_MS
    ? requested : fallback;
}

/** The host-side bound on one worker call: never shorter than the command's own limit plus a grace. */
export function workerCallTimeoutMs(name: string, args: Readonly<Record<string, unknown>>, floor = WORKER_CALL_TIMEOUT_MS): number {
  const limit = commandLimitMs(name, args);
  return limit === undefined ? floor : Math.max(floor, limit + WORKER_CALL_GRACE_MS);
}
