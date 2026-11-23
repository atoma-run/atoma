/** Published immutable native Compute images. */
export const COMPUTE_IMAGES = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:62e2aa1f08c334ac938ba31d480e2f912420c743b11c9ef5fa6b59a4fe3b9a93",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:9a6404f07397f772ccf352723c89ed42b8494d887d6a0a98c963e0e484010f07",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:8f5c828f3817d96990b96ef36301b5ea25e4b5973ce8d76f6af419bde5db3592",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:ffd40a65f7e09f0adca538f8979f4c6045ed33f13139fe77cb19fe34edd15df3"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:f87bfdcde83c0022a74c74d0a58df89cad4ea5ca103e6e705599db5de995dba7",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:e5a5e9321f42cb7aa5949dbcf84476669ee65b3bd814e81ae6038bfd355c72ce",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:1bc20b5e742ebea82d9d640a774d9049260eeafa91e7e809ecfd917742b0f47f",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:f1dc50be268e667cf0703221553d49aece2e494d1043c1065352921b5f31ab74"
  }
} as const;

/** Populated only from verified image receipts after the server understands the
 * capability. Older installed pins must never claim they can build a preview. */
export const COMPUTE_VITE_PREVIEW_IMAGES: ReadonlyArray<{ workspace: string; preview: string }> = [
  COMPUTE_IMAGES.arm64, COMPUTE_IMAGES.amd64,
];
