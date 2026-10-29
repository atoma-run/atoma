/** Published immutable native Compute images. */
export const COMPUTE_IMAGES = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:62e2aa1f08c334ac938ba31d480e2f912420c743b11c9ef5fa6b59a4fe3b9a93",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:4fcd991cf2cb4aec42bc751ba055dd749477de8121be533e2e34aff9f25a68c1",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:0385917beba0d31a6f4bb73a1b88fbed3f58353c3c63f7b6e7062bc761283307",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:ffd40a65f7e09f0adca538f8979f4c6045ed33f13139fe77cb19fe34edd15df3"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:f87bfdcde83c0022a74c74d0a58df89cad4ea5ca103e6e705599db5de995dba7",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:b8db70bcb83236ec82fefe8bf3a1920eff7b4a9b1ee25a5228cdef13b8a7a5a2",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:dceddefaaeda54062f1a3b80048c643fa4a5f975aa86b018fcbc5fe49211d31d",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:f1dc50be268e667cf0703221553d49aece2e494d1043c1065352921b5f31ab74"
  }
} as const;
