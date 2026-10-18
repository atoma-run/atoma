import { COMPUTE_IMAGES } from '../contracts/computeImages.js';
/** Immutable, CI-verified client and native image publication used by onboarding. */
export const COMPUTE_CLIENT_ARCHIVE = 'atoma-00b3779fffaa9faa754a0be5293c536306fc391c.tar.gz';
export const COMPUTE_CLIENT_ROOT = COMPUTE_CLIENT_ARCHIVE.slice(0, -7);
export const COMPUTE_CLIENT_SHA256 = 'ac63729f938f15c1c4087be723807563edcfe0d044302022bf92b809d673d69b';
export const COMPUTE_CLIENT_DOWNLOAD = `https://github.com/atoma-run/atoma/releases/download/compute-client-20261018-1/${COMPUTE_CLIENT_ARCHIVE}`;
export function computePairCommand(origin: string, architecture: 'arm64' | 'amd64'): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || !/^[a-zA-Z0-9.:/-]+$/.test(origin)) throw new Error('Invalid setup origin');
  return `npm run compute -- pair --server ${origin} --name "My computer" ` +
    Object.entries(COMPUTE_IMAGES[architecture]).map(([kind, reference]) => `--${kind}-image ${reference}`).join(' ');
}
