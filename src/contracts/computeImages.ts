/** Published immutable native Compute images. */
export const COMPUTE_IMAGES = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:b0962f62ab74037cec845a3de5491e45c595dc9619fc60a1bf0905645e834c86",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:7e6f84587b18d46b4687d6bd8e9a598cce588045840594776c3e9663981161c3",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:0385917beba0d31a6f4bb73a1b88fbed3f58353c3c63f7b6e7062bc761283307",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:ffd40a65f7e09f0adca538f8979f4c6045ed33f13139fe77cb19fe34edd15df3"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:af27c7fcb83182c399f995403907259492cd47b0372da3a22e207ded1ee2a2a5",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:7393d054ad06b0b0ed90f1fbc95d95102bc5084aaa6acf99312214e792dc20bf",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:dceddefaaeda54062f1a3b80048c643fa4a5f975aa86b018fcbc5fe49211d31d",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:f1dc50be268e667cf0703221553d49aece2e494d1043c1065352921b5f31ab74"
  }
} as const;
