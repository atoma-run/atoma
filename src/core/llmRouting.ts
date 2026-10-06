import {
  parseModelSelector,
  transportOf,
  type ModelTransport,
} from '../contracts/modelSelector.js';
import type { LlmClient, LlmCompletionRequest, LlmCompletionResponse } from './types.js';

/**
 * PER-TIER TRANSPORT ROUTING. Every request's `model` is a full selector
 * (`<mode>:<vendor>:<model>`, see `contracts/modelSelector.ts`); the router
 * parses it, hands the request to the client built for that selector's
 * TRANSPORT, and passes the vendor's bare model id down. There is no default
 * client: a selector whose transport was not constructed is a hard failure,
 * because routing to the wrong vendor is a cost/privacy bug, not a
 * recoverable hiccup.
 *
 * Observability decorators (RecordingLlmClient, MetricsLlmClient) wrap THIS
 * client, so every call is recorded exactly once regardless of which
 * transport served it — and the recorded model id keeps its selector, making
 * the payer and the vendor visible in traces and cost tables.
 */
export class RoutingLlmClient implements LlmClient {
  constructor(private readonly clients: Partial<Record<ModelTransport, LlmClient>>) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const selector = parseModelSelector(req.model, 'request model');
    const transport = transportOf(selector);
    const client = this.clients[transport];
    if (!client) {
      throw new Error(
        `RoutingLlmClient: no client for transport "${transport}" (selector ${req.model}); ` +
          'the run was constructed without it'
      );
    }
    // The response (including `servedModel`, the transport's own report of
    // what it actually invoked) flows back UNTOUCHED — the router names
    // transports, never models, so it must not overwrite the served identity
    // the observability layers price on.
    return client.complete({ ...req, model: selector.model });
  }

  /**
   * Asked of the transport the selector routes to, on its bare model id, as
   * `complete` would be. An unparsable selector honours nothing: `complete`
   * refuses it with the reason, and a capability probe must not throw first.
   */
  honoursEffort(model: string): boolean {
    let selector: ReturnType<typeof parseModelSelector>;
    try {
      selector = parseModelSelector(model, 'request model');
    } catch {
      return false;
    }
    return this.clients[transportOf(selector)]?.honoursEffort?.(selector.model) ?? false;
  }
}
