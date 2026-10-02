import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectRunEnvironment } from '../src/projects/coordinator.js';
import { PLATFORM_TISSUE_AUTHOR_ENV, platformTissueAuthorSchema } from '../src/contracts/tissueRouting.js';
import { DEFAULT_PLATFORM_LIMITS } from '../src/contracts/platformSettings.js';
import { capturePlatformTissueAuthor, platformTissueAuthor } from '../src/run/tissueAuthor.js';
import { makeAnthropicClient } from '../src/run/auth.js';
import { codexChildEnvironment } from '../src/core/llmCodexCli.js';
import { subscriptionTransportEnv } from '../src/core/llmClaudeCli.js';
import { sandboxChildEnv } from '../src/tools/sandbox.js';
import { makeCtx } from './helpers.js';
import { hostLifecycleSnapshot, resetHostLifecycleSnapshotForTests } from '../src/run/runner.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); resetHostLifecycleSnapshotForTests(); });

const paths = {
  dbPath: '/control/atoma.db', workspacePath: '/control/workspace', runsPath: '/control/runs',
  skillsPath: '/control/skills', runId: '3c584a3c-933d-4488-ac44-4cdcc8e66f31', artifactManifestPath: '/control/manifest.json',
};
const host = {
  PATH: process.env['PATH'], HOME: process.env['HOME'], SYSTEMROOT: process.env['SYSTEMROOT'],
  ATOMA_MODEL_L1: 'api:openai:gpt-6-luna', ATOMA_MODEL_L2: 'api:openai:gpt-6-sol', ATOMA_MODEL_L3: 'api:openai:gpt-6-astra',
  OPENAI_API_KEY: 'platform-key', OPENAI_BASE_URL: 'https://platform-gateway.invalid/v1',
  ANTHROPIC_API_KEY: 'unrelated-secret', ATOMA_GITHUB_APP_PRIVATE_KEY: 'unrelated-private-key',
};

describe('platform tissue author credential boundary', () => {
  it('retains the original host pin after a previous in-process run replaces ambient tier pins', () => {
    vi.stubEnv('ATOMA_TENANT_RUN', '0');
    vi.stubEnv('ATOMA_MODEL_L3', host.ATOMA_MODEL_L3);
    vi.stubEnv('OPENAI_API_KEY', host.OPENAI_API_KEY);
    resetHostLifecycleSnapshotForTests();
    const original = hostLifecycleSnapshot().tissueAuthor;
    vi.stubEnv('ATOMA_MODEL_L3', 'own:openai:gpt-5.6-luna');
    expect(hostLifecycleSnapshot().tissueAuthor).toBe(original);
    expect(JSON.parse(original!).model).toBe(host.ATOMA_MODEL_L3);
  });

  it('crosses the project process boundary with the platform L3 and key even when the customer uses the same vendor', () => {
    const { environment } = projectRunEnvironment({ ...paths, hostEnv: host,
      tierModels: { l1: 'api:openai:gpt-6-luna', l2: 'api:openai:gpt-6-luna', l3: 'api:openai:gpt-6-luna' },
      orgProviderKeys: { openai: 'customer-key' },
    });
    expect(environment['ATOMA_MODEL_L3']).toBe('api:openai:gpt-6-luna');
    expect(environment['OPENAI_API_KEY']).toBe('customer-key');
    expect(environment['OPENAI_BASE_URL']).toBeUndefined();
    const snapshot = environment[PLATFORM_TISSUE_AUTHOR_ENV]!;
    expect(snapshot).not.toContain('unrelated-');
    expect(snapshot).not.toContain('customer-key');
    // A real child and the real SDK construction path; only HTTP is stubbed.
    // No provider call or quota is used by this regression.
    const script = `
      import { platformTissueAuthor } from './src/run/tissueAuthor.ts';
      import { PLATFORM_TISSUE_AUTHOR_ENV } from './src/contracts/tissueRouting.ts';
      import { DEFAULT_PLATFORM_LIMITS } from './src/contracts/platformSettings.ts';
      let sent;
      globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        sent = { url: String(url), authorization: new Headers(init.headers).get('authorization'), model: body.model };
        return new Response(JSON.stringify({ id: 'resp_test', object: 'response', status: 'completed', model: body.model,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'authored', annotations: [] }] }],
          usage: { input_tokens: 4, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
      };
      const author = platformTissueAuthor(process.env[PLATFORM_TISSUE_AUTHOR_ENV], client => client, DEFAULT_PLATFORM_LIMITS);
      await author.llm.complete({ model: author.model, systemPrompt: 'author', userContent: 'a reusable capability' });
      console.log(JSON.stringify(sent));
    `;
    const sent = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      env: environment, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    }).trim());
    expect(sent).toEqual({ url: 'https://platform-gateway.invalid/v1/responses', authorization: 'Bearer platform-key', model: 'gpt-6-astra' });
    expect(codexChildEnvironment(environment)).not.toHaveProperty(PLATFORM_TISSUE_AUTHOR_ENV);
    expect(subscriptionTransportEnv(environment)).not.toHaveProperty(PLATFORM_TISSUE_AUTHOR_ENV);
    vi.stubEnv(PLATFORM_TISSUE_AUTHOR_ENV, snapshot);
    expect(sandboxChildEnv()).not.toHaveProperty(PLATFORM_TISSUE_AUTHOR_ENV);
  });

  it('captures the platform Codex profile independently of the requesting account profile', () => {
    const { environment } = projectRunEnvironment({ ...paths,
      hostEnv: { ...host, ATOMA_MODEL_L3: 'sub:openai:gpt-5.6-sol', CODEX_HOME: '/platform/codex', CODEX_SQLITE_HOME: '/platform/codex', ATOMA_CODEX_MODEL: 'gpt-5.6-luna' },
      tierModels: { l1: null, l2: null, l3: 'own:openai:gpt-5.6-luna' },
      principalCodexProfile: { profileId: 'personal', homePath: '/customer/codex', profilesRoot: '/customer' },
    });
    const snapshot = platformTissueAuthorSchema.parse(JSON.parse(environment[PLATFORM_TISSUE_AUTHOR_ENV]!));
    expect(snapshot).toMatchObject({ model: 'sub:openai:gpt-5.6-sol', env: { CODEX_HOME: '/platform/codex', CODEX_SQLITE_HOME: '/platform/codex' } });
    expect(environment['CODEX_HOME']).toContain('customer');
    expect(snapshot.env).not.toHaveProperty('ATOMA_CODEX_MODEL');
    expect(snapshot.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(JSON.stringify(snapshot)).not.toContain('customer');
  });

  it('keeps an explicit Anthropic endpoint and credentials independent of the ambient customer', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'customer-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://customer.invalid');
    const snapshot = platformTissueAuthorSchema.parse(JSON.parse(capturePlatformTissueAuthor({
      ATOMA_MODEL_L3: 'api:anthropic:claude-opus-5', ANTHROPIC_API_KEY: 'platform-key',
    })));
    const client = makeAnthropicClient(snapshot.env);
    expect(client.apiKey).toBe('platform-key');
    expect(client.baseURL).toBe('https://api.anthropic.com');
  });

  it.each([undefined, capturePlatformTissueAuthor({}), capturePlatformTissueAuthor({ ATOMA_MODEL_L3: 'api:openai:gpt-6-astra' }),
    capturePlatformTissueAuthor({ ATOMA_MODEL_L3: 'own:openai:gpt-5.6-sol' })])('refuses creation without a usable platform configuration, ignoring ambient customer credentials', (snapshot) => {
    vi.stubEnv('OPENAI_API_KEY', 'customer-key');
    vi.stubEnv('ATOMA_MODEL_L3', 'api:openai:gpt-6-luna');
    const wrap = vi.fn(() => makeCtx().llm);
    expect(() => platformTissueAuthor(snapshot, wrap, DEFAULT_PLATFORM_LIMITS)).toThrow();
    expect(wrap).not.toHaveBeenCalled();
  });
});
