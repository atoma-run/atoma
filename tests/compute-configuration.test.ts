import { expect, it } from 'vitest';
import { computeConfiguration } from '../src/projects/computeConfiguration.js';

it('keeps hosted deployments unchanged until compute is explicitly enabled', () => {
  expect(computeConfiguration({})).toBeNull();
  expect(computeConfiguration({ ATOMA_COMPUTE_ENABLED: 'false' })).toBeNull();
  expect(() => computeConfiguration({ ATOMA_COMPUTE_ENABLED: 'maybe' })).toThrow();
});
it('requires explicit bounded application versions and immutable image digests', () => {
  expect(() => computeConfiguration({ ATOMA_COMPUTE_ENABLED: '1' })).toThrow('APP_VERSIONS');
  const env = { ATOMA_COMPUTE_ENABLED: '1', ATOMA_COMPUTE_APP_VERSIONS: 'test-1' };
  expect(() => computeConfiguration(env)).toThrow('IMAGE_DIGESTS');
  expect(() => computeConfiguration({ ...env, ATOMA_COMPUTE_IMAGE_DIGESTS: 'image:latest' })).toThrow();
  const digest = `sha256:${'a'.repeat(64)}`;
  expect(computeConfiguration({ ...env, ATOMA_COMPUTE_IMAGE_DIGESTS: digest }))
    .toEqual({ appVersions: new Set(['test-1']), imageDigests: new Set([digest]) });
  expect(() => computeConfiguration({ ...env, ATOMA_COMPUTE_IMAGE_DIGESTS: Array(33).fill(digest).join(',') })).toThrow();
});
