import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { generateHaystackConfig } from '../src/cli/haystackConfig.js';
import { haystackLaunchSchema, HAYSTACK_LAUNCH_ENV } from '../src/contracts/retrievalHaystack.js';
import { readComputeHaystackLaunch, COMPUTE_HAYSTACK_CONFIG_ENV, COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV } from '../src/contracts/computeRetrievalConfig.js';
import { verifyHaystackLaunch } from '../src/projects/retrievalRuntime.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe('host Haystack configuration', () => {
  it('generates pins through a real child and detects later model/runtime changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'haystack-config-')); roots.push(root);
    const python = join(root, 'python');
    const runtime = (digest: string) => writeFileSync(python, `#!${process.execPath}\nif(process.env.OPENAI_API_KEY || process.env.HOME || process.env.HF_HUB_OFFLINE !== '1') process.exit(1);\nconsole.log(JSON.stringify({sha256:${JSON.stringify(digest)}}));\n`, { mode: 0o700 });
    runtime('a'.repeat(64));
    const models = join(root, 'models'); mkdirSync(models); writeFileSync(join(models, 'weights'), 'original');
    const config = haystackLaunchSchema.parse(JSON.parse(await generateHaystackConfig([
      '--python', python, '--embedding', models, '--reranker', models, '--query-prefix', '',
    ])));
    await expect(verifyHaystackLaunch(config)).resolves.toBeUndefined();
    writeFileSync(join(models, 'weights'), 'changed');
    await expect(verifyHaystackLaunch(config)).rejects.toThrow('model content changed');
    runtime('b'.repeat(64));
    await expect(verifyHaystackLaunch(config)).rejects.toThrow('Python package identity changed');
  });
  it('refuses partial hybrid settings and unknown options', async () => {
    await expect(generateHaystackConfig(['--python', '/missing', '--embedding', '/models'])).rejects.toThrow('Hybrid mode requires');
    await expect(generateHaystackConfig(['--unknown'])).rejects.toThrow();
  });
});

describe('host-owned per-device Compute retrieval configuration', () => {
  const config = (identity: string) => ({ python: join(tmpdir(), 'runtime-python'), settings: { mode: 'bm25' as const }, runtimeSha256: identity.repeat(64) });
  it('selects only an exact device and retains both legacy fallbacks', () => {
    const selected = randomUUID(), other = randomUUID();
    const env: NodeJS.ProcessEnv = { [HAYSTACK_LAUNCH_ENV]: JSON.stringify(config('a')),
      [COMPUTE_HAYSTACK_CONFIG_ENV]: JSON.stringify(config('b')),
      [COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV]: JSON.stringify({ [selected]: config('c') }) };
    expect(readComputeHaystackLaunch(env, selected)).toEqual(config('c'));
    expect(readComputeHaystackLaunch(env, other)).toEqual(config('b'));
    delete env[COMPUTE_HAYSTACK_CONFIG_ENV];
    expect(readComputeHaystackLaunch(env, other)).toEqual(config('a'));
    delete env[COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV];
    expect(readComputeHaystackLaunch(env, selected)).toEqual(config('a'));
  });
  it('does not require an unused fallback for a fully configured selected device', () => {
    const selected = randomUUID();
    expect(readComputeHaystackLaunch({ [COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV]: JSON.stringify({ [selected]: config('c') }),
      [COMPUTE_HAYSTACK_CONFIG_ENV]: 'unused-invalid-value' }, selected)).toEqual(config('c'));
  });
  it.each(['', '{', 'null', '[]', ' '.repeat(65537),
    JSON.stringify({ 'not-a-device': config('c') }), JSON.stringify({ [randomUUID()]: { ...config('c'), unexpected: true } }),
    JSON.stringify({ [randomUUID()]: { ...config('c'), runtimeSha256: 'invalid' } }),
    '{"__proto__":' + JSON.stringify(config('c')) + '}'])('refuses an invalid configured map without falling back (%#)', raw => {
    expect(() => readComputeHaystackLaunch({ [HAYSTACK_LAUNCH_ENV]: JSON.stringify(config('a')),
      [COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV]: raw }, randomUUID())).toThrow(COMPUTE_HAYSTACK_CONFIG_BY_DEVICE_ENV);
  });
});
