import { homedir } from 'node:os';
import { join } from 'node:path';
import { platformTissueAuthorSchema } from '../contracts/tissueRouting.js';
import { parseModelSelector, tryParseModelSelector, transportOf } from '../contracts/modelSelector.js';
import type { PlatformLimits } from '../contracts/platformSettings.js';
import { CODEX_CHILD_ENV_KEYS } from '../core/llmCodexCli.js';
import { PERSONAL_CODEX_PROFILE_ROOT_ENV } from '../core/codexHomeLease.js';
import { findProvider } from '../core/providerCatalog.js';
import { RoutingLlmClient } from '../core/llmRouting.js';
import { RunnerConfigError } from '../core/errors.js';
import type { LlmClient } from '../core/types.js';
import { makeTransportClient } from './providers.js';

export interface TissueAuthor {
  readonly model: string;
  readonly llm: LlmClient;
}

/** Capture BEFORE customer pins/credentials are resolved. Missing configuration is checked only on creation. */
export function capturePlatformTissueAuthor(host: NodeJS.ProcessEnv): string {
  const model = host['ATOMA_MODEL_L3']?.trim() ?? '';
  const selector = tryParseModelSelector(model);
  const env: Record<string, string> = {};
  if (selector?.mode === 'api') {
    const provider = findProvider(selector.vendor)!;
    if (provider.credentialEnvVar && host[provider.credentialEnvVar]) {
      env[provider.credentialEnvVar] = host[provider.credentialEnvVar]!;
    }
    // Explicit even at the default: SDKs must not read a customer's ambient gateway.
    env[provider.baseUrlEnvVar] = host[provider.baseUrlEnvVar]?.trim() || provider.defaultBaseUrl;
    if (selector.vendor === 'anthropic') {
      for (const key of ['ANTHROPIC_AUTH_TOKEN', 'ATOMA_AUTH']) {
        if (host[key] !== undefined) env[key] = host[key]!;
      }
    }
  } else if (selector?.mode === 'sub') {
    for (const key of CODEX_CHILD_ENV_KEYS) {
      if (key !== PERSONAL_CODEX_PROFILE_ROOT_ENV && host[key] !== undefined) env[key] = host[key]!;
    }
    const home = host['HOME'] || host['USERPROFILE'] || homedir();
    env['HOME'] = home;
    if (selector.vendor === 'openai') {
      env['CODEX_HOME'] = host['CODEX_HOME'] || join(home, '.codex');
    } else {
      delete env['CODEX_HOME'];
      delete env['CODEX_SQLITE_HOME'];
      env['CLAUDE_CONFIG_DIR'] = host['CLAUDE_CONFIG_DIR'] || join(home, '.claude');
      if (host['CLAUDE_CODE_OAUTH_TOKEN']) env['CLAUDE_CODE_OAUTH_TOKEN'] = host['CLAUDE_CODE_OAUTH_TOKEN'];
    }
  }
  // No debug model collapse, personal inventory, run keys or nested author envelope.
  return JSON.stringify({ model, env });
}

/** A separate client, even when the run uses the same vendor. Never fall back to its credentials. */
export function platformTissueAuthor(
  snapshot: string | undefined,
  wrap: (client: LlmClient) => LlmClient,
  limits: PlatformLimits,
): TissueAuthor {
  if (!snapshot) throw new RunnerConfigError('New tissues require the platform L3 author configuration; customer credentials cannot author shared tissues.');
  let raw: unknown;
  try { raw = JSON.parse(snapshot); } catch { throw new RunnerConfigError('Invalid platform tissue author configuration.'); }
  const parsed = platformTissueAuthorSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.model) throw new RunnerConfigError('Configure ATOMA_MODEL_L3 on the platform to author new tissues.');
  const { model, env } = parsed.data;
  const selector = parseModelSelector(model);
  if (selector.mode === 'own') throw new RunnerConfigError('A tissue author must use the platform credential, never a personal subscription.');
  const provider = findProvider(selector.vendor)!;
  if (selector.mode === 'api' && provider.credentialEnvVar) {
    const bearer = selector.vendor === 'anthropic' && env['ANTHROPIC_AUTH_TOKEN']?.trim();
    const key = env[provider.credentialEnvVar]?.trim();
    const ignoresKey = selector.vendor === 'anthropic' && env['ATOMA_AUTH']?.toLowerCase() === 'cli';
    if ((!key || ignoresKey) && !bearer) {
      throw new RunnerConfigError(`New tissues require the platform's ${provider.credentialEnvVar}; customer credentials are never substituted.`);
    }
  }
  const transport = transportOf(selector);
  return { model, llm: wrap(new RoutingLlmClient({ [transport]: makeTransportClient(transport, { env, limits }) })) };
}
