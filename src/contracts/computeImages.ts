/** Published immutable native Compute images. */
export const COMPUTE_IMAGES = {
  "arm64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:7f2cda61d07c145dbf1beaf804153b1047b0ce6e2d41037d48fcf3a92710dc7e",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:92239596c38b938154c8dd659c49cc8b2831f4d1d53f98f2b617f307989edb9e",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:0385917beba0d31a6f4bb73a1b88fbed3f58353c3c63f7b6e7062bc761283307",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:ffd40a65f7e09f0adca538f8979f4c6045ed33f13139fe77cb19fe34edd15df3"
  },
  "amd64": {
    "worker": "ghcr.io/atoma-run/atoma/compute-worker@sha256:0c260b3447393209bf8c576db5b7489c8c588c89e020613c4f4195adb8f3c3b7",
    "workspace": "ghcr.io/atoma-run/atoma/compute-workspace@sha256:078e981e1b9244eddb11d65e99df1460b3c11a00daed3a6fa01265ad210bb5a5",
    "preview": "ghcr.io/atoma-run/atoma/compute-preview@sha256:dceddefaaeda54062f1a3b80048c643fa4a5f975aa86b018fcbc5fe49211d31d",
    "retrieval": "ghcr.io/atoma-run/atoma/compute-retrieval@sha256:f1dc50be268e667cf0703221553d49aece2e494d1043c1065352921b5f31ab74"
  }
} as const;
