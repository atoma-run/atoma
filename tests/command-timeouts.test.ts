import { describe, expect, it } from 'vitest';
import {
  PROBE_TIMEOUT_MS, SHELL_TIMEOUT_MAX_MS, SHELL_TIMEOUT_MS, WORKER_CALL_GRACE_MS, WORKER_CALL_TIMEOUT_MS, workerCallTimeoutMs,
} from '../src/contracts/commandTimeouts.js';
import * as builtin from '../src/tools/builtin.js';

// Run 90ad4303 (2026-10-15), the first after record_probe's default rose to
// 120 s: the container worker's host-side bound was a flat 120 s, so a probe
// was abandoned by the host at the instant the worker would have recorded it
// ("timed out after 120000ms in the worker"), and every longer limit was
// capped at 120 s in a container.
describe('the host waits for a worker command as long as the command may run', () => {
  it('outlasts each command limit by the grace: defaults, requests and the maximum', () => {
    expect(workerCallTimeoutMs('record_probe', {})).toBe(PROBE_TIMEOUT_MS + WORKER_CALL_GRACE_MS);
    expect(workerCallTimeoutMs('record_probe', { timeoutMs: SHELL_TIMEOUT_MAX_MS })).toBe(SHELL_TIMEOUT_MAX_MS + WORKER_CALL_GRACE_MS);
    expect(workerCallTimeoutMs('run_shell', { timeoutMs: 200_000 })).toBe(200_000 + WORKER_CALL_GRACE_MS);
    // The default run_shell limit (120 s since 2026-10-26) outlasts the ordinary bound by the grace;
    // a short command keeps the ordinary bound rather than a shorter one.
    expect(workerCallTimeoutMs('run_shell', {})).toBe(SHELL_TIMEOUT_MS + WORKER_CALL_GRACE_MS);
    expect(workerCallTimeoutMs('run_shell', { timeoutMs: 1_000 })).toBe(WORKER_CALL_TIMEOUT_MS);
  });

  it('keeps the ordinary bound for other tools and for requests the tool refuses', () => {
    expect(workerCallTimeoutMs('validate_html', { timeoutMs: SHELL_TIMEOUT_MAX_MS })).toBe(WORKER_CALL_TIMEOUT_MS);
    for (const timeoutMs of [SHELL_TIMEOUT_MAX_MS + 1, 0, 1.5, '200000']) {
      expect(workerCallTimeoutMs('record_probe', { timeoutMs })).toBe(PROBE_TIMEOUT_MS + WORKER_CALL_GRACE_MS);
    }
  });

  it('honours a configured per-call floor and shares one definition with the tools', () => {
    expect(workerCallTimeoutMs('validate_html', {}, 60_000)).toBe(60_000);
    expect(workerCallTimeoutMs('record_probe', {}, 600_000)).toBe(600_000);
    expect([builtin.SHELL_TIMEOUT_MS, builtin.PROBE_TIMEOUT_MS, builtin.SHELL_TIMEOUT_MAX_MS])
      .toEqual([SHELL_TIMEOUT_MS, PROBE_TIMEOUT_MS, SHELL_TIMEOUT_MAX_MS]);
  });
});
