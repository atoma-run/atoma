/** Published immutable native Compute images. */
export const COMPUTE_IMAGES = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:d3f0de678c4be18aa097382a10b4797f702cedd6a1e8807c029d85da7c8567aa",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:4fcd991cf2cb4aec42bc751ba055dd749477de8121be533e2e34aff9f25a68c1",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:0385917beba0d31a6f4bb73a1b88fbed3f58353c3c63f7b6e7062bc761283307",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:ffd40a65f7e09f0adca538f8979f4c6045ed33f13139fe77cb19fe34edd15df3"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:bd2cc20b2f6f48c269ff3b37696301e5e8b4a3e9d28f1d992eed24da604e81a0",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:b8db70bcb83236ec82fefe8bf3a1920eff7b4a9b1ee25a5228cdef13b8a7a5a2",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:dceddefaaeda54062f1a3b80048c643fa4a5f975aa86b018fcbc5fe49211d31d",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:f1dc50be268e667cf0703221553d49aece2e494d1043c1065352921b5f31ab74"
  }
} as const;
