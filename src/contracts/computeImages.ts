/** Published immutable native Compute images. */
export const COMPUTE_IMAGES = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:cbd1e3827bd7e6b3bcb6dce25522de68fd95fe4ba2ba869d1bdb4f2e8b683211",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:7e6f84587b18d46b4687d6bd8e9a598cce588045840594776c3e9663981161c3",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:0385917beba0d31a6f4bb73a1b88fbed3f58353c3c63f7b6e7062bc761283307",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:ffd40a65f7e09f0adca538f8979f4c6045ed33f13139fe77cb19fe34edd15df3"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:8004701bb45378bce0671bbe0d5b86f094b2b09dd27817af623bebf78b68317c",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:7393d054ad06b0b0ed90f1fbc95d95102bc5084aaa6acf99312214e792dc20bf",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:dceddefaaeda54062f1a3b80048c643fa4a5f975aa86b018fcbc5fe49211d31d",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:f1dc50be268e667cf0703221553d49aece2e494d1043c1065352921b5f31ab74"
  }
} as const;
