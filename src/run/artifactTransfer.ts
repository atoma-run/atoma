import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { artifactManifestSchema, type ArtifactManifest } from '../contracts/artifactInventory.js';
import { WORKSPACE_LIMITS } from '../contracts/workspaceLimits.js';
import type { ArtifactExport, ArtifactExportOptions } from '../contracts/workspaceRuntime.js';
import { assertPublishableArtifactPath, buildWorkspaceArtifactManifest, normalizeArtifactPath,
  readManifestArtifact, revalidateArtifactManifest } from '../projects/artifacts.js';
import { captureCheckpointExport } from './checkpointExport.js';
import { WorkspaceImport, restoreWorkspaceExport } from './workspaceImport.js';

/** Reuse publication policy. This is a byte transfer, never delivery approval. */
function validateManifest(input: ArtifactManifest): ArtifactManifest {
  if (input.files.length > WORKSPACE_LIMITS.maxFiles || input.totalBytes > WORKSPACE_LIMITS.maxTotalBytes) {
    throw new Error('Artifact transfer exceeds limits');
  }
  const manifest = artifactManifestSchema.parse(input);
  if (manifest.source !== 'workspace') throw new Error('Artifact transfer requires a complete workspace inventory');
  for (const file of manifest.files) {
    if (file.size > WORKSPACE_LIMITS.maxFileBytes || normalizeArtifactPath(file.path) !== file.path) {
      throw new Error('Invalid artifact transfer file');
    }
    assertPublishableArtifactPath(file.path);
  }
  return manifest;
}

/** Caller confirms process exit first. Spool only publishable files, privately. */
export function captureArtifactExport(root: string, options: ArtifactExportOptions): ArtifactExport {
  const { manifest } = buildWorkspaceArtifactManifest({ workspaceRoot: root, ...options });
  return captureManifestExport(root, manifest);
}

/** Export exactly a host-authorized saved manifest, including its recorded modes. */
export function captureManifestExport(root: string, input: ArtifactManifest): ArtifactExport {
  const manifest = validateManifest(input);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'atoma-artifact-export-')));
  try {
    for (const file of manifest.files) {
      const bytes = readManifestArtifact({ workspaceRoot: root, expected: file });
      const target = join(temporary, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx', mode: Number.parseInt(file.mode, 8) & 0o777 });
      chmodSync(target, Number.parseInt(file.mode, 8) & 0o777);
    }
    revalidateArtifactManifest({ workspaceRoot: root, manifest });
    revalidateArtifactManifest({ workspaceRoot: temporary, manifest });
    return { ...captureCheckpointExport(temporary), manifest };
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

/** Stage outside the final path; verify bytes and the exact inventory before rename.
 * The trusted coordinator owns target and must commit delivery separately. */
export async function receiveArtifactExport(exporting: ArtifactExport, target: string): Promise<ArtifactManifest> {
  let staging: string | undefined;
  try {
    const manifest = validateManifest(exporting.manifest);
    if (existsSync(target)) throw new Error('Artifact destination must be new');
    mkdirSync(dirname(target), { recursive: true });
    staging = mkdtempSync(join(dirname(target), '.artifact-transfer-'));
    const received = join(staging, 'received');
    const files = new Map(manifest.files.map(file => [file.path, file]));
    const directories = new Set<string>();
    for (const file of manifest.files) {
      for (let parent = dirname(file.path); parent !== '.'; parent = dirname(parent)) directories.add(parent);
    }
    await restoreWorkspaceExport({ importWorkspace: async header => {
      const writer = new WorkspaceImport(received, header, false);
      return {
        begin: entry => {
          const expected = files.get(entry.path);
          if (entry.kind === 'directory' ? !directories.has(entry.path) || entry.size !== 0
            : entry.kind !== 'file' || !expected || entry.size !== expected.size ||
              (entry.mode & 0o777) !== (Number.parseInt(expected.mode, 8) & 0o777)) {
            throw new Error('Artifact entry is not in the manifest');
          }
          writer.begin(entry);
        },
        append: (offset, bytes) => writer.append(offset, bytes),
        finish: () => writer.finish(), abort: () => writer.abort(),
      };
    } }, exporting, false);
    revalidateArtifactManifest({ workspaceRoot: received, manifest });
    if (existsSync(target)) throw new Error('Artifact destination must be new');
    // Remote metadata must never widen access to the host's saved delivery.
    chmodSync(received, 0o700);
    renameSync(received, target);
    return manifest;
  } finally {
    try { await exporting.close(); }
    finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
  }
}
