import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const { REPOSITORY, REVISION, ARCHITECTURE, RELEASE_TAG, COMPUTE_RECEIPT_DIR } = process.env;
if (!/^[\w.-]+\/[\w.-]+$/.test(REPOSITORY ?? '') || !/^[a-f0-9]{40}$/.test(REVISION ?? '') ||
  !['amd64', 'arm64'].includes(ARCHITECTURE) || (RELEASE_TAG && !/^v[\w.+-]+$/.test(RELEASE_TAG)) ||
  (!RELEASE_TAG && !COMPUTE_RECEIPT_DIR)) throw new Error('Invalid Compute release identity');
const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
const images = {};
for (const kind of ['worker', 'workspace', 'preview', 'retrieval']) {
  const local = `atoma-${kind}:compute-ci`;
  const inspected = JSON.parse(docker(['image', 'inspect', '--format', '{{json .}}', local]));
  if (inspected.Architecture !== ARCHITECTURE || inspected.Os !== 'linux' || inspected.Config.Labels['org.opencontainers.image.revision'] !== REVISION) throw new Error('Compute image identity mismatch');
  const name = `ghcr.io/${REPOSITORY.toLowerCase()}/compute-${kind}`;
  const tag = `${name}:${REVISION}-${ARCHITECTURE}`;
  docker(['tag', local, tag]); docker(['push', tag]);
  const references = JSON.parse(docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', tag]));
  const reference = references.find(value => value.startsWith(name + '@sha256:'));
  if (!reference || !/@sha256:[a-f0-9]{64}$/.test(reference)) throw new Error('Registry did not confirm an immutable image');
  images[kind] = { reference, contentDigest: inspected.Id };
}
const retrievalModels = JSON.parse(docker(['run', '--rm', '--network', 'none', '--read-only', '--entrypoint', 'node',
  'atoma-retrieval:compute-ci', '-e', "process.stdout.write(require('node:fs').readFileSync('/models/models.json','utf8'))"]));
const retrievalRuntime = JSON.parse(docker(['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp',
  '--entrypoint', '/opt/haystack/bin/python', 'atoma-retrieval:compute-ci', '-I', '/scripts/retrieval-haystack.py', '--identity']));
const haystackConfig = { python: '/opt/haystack/bin/python', runtimeSha256: retrievalRuntime.sha256,
  settings: { ...retrievalModels, embeddingPath: '/models/embedding', rerankerPath: '/models/reranker' } };
const root = COMPUTE_RECEIPT_DIR || mkdtempSync(join(tmpdir(), 'compute-release-'));
mkdirSync(root, { recursive: true });
try {
  const name = `atoma-compute-images-linux-${ARCHITECTURE}.json`;
  const bytes = JSON.stringify({ version: 1, revision: REVISION, architecture: ARCHITECTURE, images, haystackConfig }, null, 2) + '\n';
  writeFileSync(join(root, name), bytes);
  writeFileSync(join(root, name + '.sha256'), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
  if (RELEASE_TAG) execFileSync('gh', ['release', 'upload', RELEASE_TAG, join(root, name), join(root, name + '.sha256'), '--repo', REPOSITORY], { stdio: 'inherit' });
} finally { if (!COMPUTE_RECEIPT_DIR) rmSync(root, { recursive: true, force: true }); }
