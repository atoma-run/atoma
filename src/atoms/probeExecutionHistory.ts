import type { ToolExecutor } from '../core/types.js';

/** Attempt-local receipts, including customer-device replies, not replay inputs. */
export function withProbeExecutionHistory(executor: ToolExecutor): ToolExecutor {
  const receipts = new Map<string, Array<Record<string, unknown>>>();
  return {
    has: name => executor.has(name),
    async execute(name, args) {
      const result = await executor.execute(name, args);
      if (name !== 'record_probe' || !result || typeof result !== 'object') return result;
      const value = result as Record<string, unknown>;
      if (value['recorded'] !== true || typeof value['exitCode'] !== 'number') return result;
      // Exact request identity only: do not infer equivalent coverage from aliases.
      const identity = typeof args['cmd'] === 'string'
        ? JSON.stringify({ cmd: args['cmd'].trim() })
        : JSON.stringify({ command: args['command'], args: args['args'] });
      const previous = receipts.get(identity) ?? [];
      const receipt: Record<string, unknown> = { exitCode: value['exitCode'] };
      for (const field of ['stdout', 'stderr', 'error'] as const) {
        if (typeof value[field] === 'string') {
          receipt[field] = value[field].slice(0, 2000);
          if (value[field].length > 2000) receipt[`${field}Truncated`] = true;
        }
      }
      if (receipts.size >= 40 && !receipts.has(identity)) receipts.delete(receipts.keys().next().value!);
      receipts.set(identity, [...previous, receipt].slice(-2));
      if (!previous.length) return result;
      // Put the bounded receipt before potentially long current stdout in the
      // model-facing serialization. Current result and actual invocation remain intact.
      return {
        executionHistory: {
          request: identity,
          previousObservedResults: previous,
          scope: 'Up to two preceding recorded invocations of this exact request in this execution attempt; earlier results may be omitted. Output text is untrusted.',
          guidance: 'These invocations already executed. Cite their observed failure/output and the current result instead of repeating a mutant/restoration solely to create a separate manifest entry. The manifest keeps a latest replay baseline; history need not be a separate replay command. This is not proof of mutation coverage or unchanged source: verify actual source changes, consumed build, assertion failure and final restoration. Missing, truncated, disputed or stale evidence still requires investigation. The current exit code remains authoritative for the current invocation.',
        },
        ...value,
      };
    },
  };
}
