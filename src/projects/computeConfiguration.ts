import { computeCapabilitiesSchema } from '../contracts/computeDevice.js';

/** Deployment-owned allowlists. Project settings cannot alter runtime identity policy. */
export function computeConfiguration(env: NodeJS.ProcessEnv) {
  const enabled = env['ATOMA_COMPUTE_ENABLED'];
  if (enabled === undefined || enabled === '0' || enabled === 'false') return null;
  if (enabled !== '1' && enabled !== 'true') throw new Error('ATOMA_COMPUTE_ENABLED must be a boolean');
  const entries = (key: string) => {
    const values = env[key]?.split(',').map(value => value.trim()) ?? [];
    if (!values.length || values.length > 32 || values.some(value => !value)) throw new Error(`${key} requires 1–32 explicit identities`);
    return values;
  };
  return {
    appVersions: new Set(entries('ATOMA_COMPUTE_APP_VERSIONS').map(value => computeCapabilitiesSchema.shape.appVersion.parse(value))),
    imageDigests: new Set(entries('ATOMA_COMPUTE_IMAGE_DIGESTS').map(value => computeCapabilitiesSchema.shape.imageDigest.parse(value))),
  };
}
