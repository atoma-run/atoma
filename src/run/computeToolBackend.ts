import type { Tool } from '../core/types.js';
import type { ComputeToolCommand } from '../contracts/computeTools.js';
import type { ToolBackend } from './toolBackend.js';

/** Host-owned declarations; the customer cannot invent model-facing elements.
 * Drain remains remote and acknowledged: a socket timeout never means stopped. */
export function computeToolBackend(options: {
  declarations: readonly Tool[];
  send: (command: ComputeToolCommand) => Promise<unknown>;
}): ToolBackend {
  let stopped = false, draining: Promise<void> | undefined;
  const names = new Set(options.declarations.map(tool => tool.name));
  const drain = () => draining ??= (async () => {
    stopped = true;
    await options.send({ method: 'drain' });
  })();
  return {
    provenance: 'customer-device',
    toolDecls: [...options.declarations], rootLabel: 'Customer device', cleanup: drain, drain,
    executor: {
      has: name => !stopped && names.has(name),
      execute: async (name, args) => {
        if (stopped || !names.has(name)) throw new Error('Compute tool unavailable');
        return options.send({ method: 'invoke', name, args });
      },
    },
  };
}
