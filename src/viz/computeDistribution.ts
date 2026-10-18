/** Immutable, CI-verified client and native image publication used by onboarding. */
export const COMPUTE_CLIENT_ARCHIVE = 'atoma-00b3779fffaa9faa754a0be5293c536306fc391c.tar.gz';
export const COMPUTE_CLIENT_ROOT = COMPUTE_CLIENT_ARCHIVE.slice(0, -7);
export const COMPUTE_CLIENT_SHA256 = 'ac63729f938f15c1c4087be723807563edcfe0d044302022bf92b809d673d69b';
export const COMPUTE_CLIENT_DOWNLOAD = `https://github.com/atoma-run/atoma/releases/download/compute-client-20261018-1/${COMPUTE_CLIENT_ARCHIVE}`;
const images = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:7af8dc09581caef52ef1dff49c6a77e575b17cdf9271cd9c94260c706f525107",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:a52cd93a8296576892dfebc6fcf2cc8e323871c6881342ca465450e3c35a88e3",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:4fa5d50b930407a1f58aa139d46d33472df4383b79a148e9823bd300d8ca8f3c",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:50ef59a779e8959fc898bac5a74dcdd6debf37ea64a5b8b94f0f8a755621ba0d"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:33cf3f38adfdd83cad58f04d40e3aa3b92f7b6521e6eb6bae10a0f4ae83a51fc",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:897447e618776401e1e0c88f53bbeecfc075509107eddf625683fe88e7479e1f",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:bf1b181bf74f978b68ba03872310d37d65620a8af9285ef9fe6fb3b2432f769e",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:e82ca33e583fc2b6873eff826fad4c2cba24d0e30bce358280f12f14470eef84"
  }
} as const;
export function computePairCommand(origin: string, architecture: 'arm64' | 'amd64'): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || !/^[a-zA-Z0-9.:/-]+$/.test(origin)) throw new Error('Invalid setup origin');
  return `npm run compute -- pair --server ${origin} --name "My computer" ` +
    Object.entries(images[architecture]).map(([kind, reference]) => `--${kind}-image ${reference}`).join(' ');
}
