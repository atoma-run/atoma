import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePreviewCommandSchema } from '../contracts/computePreview.js';
import { materializePreviewWorkspace } from './policy.js';
import { classifyDeliveredWorkspace } from './descriptor.js';
import { artifactManifestHash, buildWorkspaceArtifactManifest } from '../projects/artifacts.js';
import { previewCopyLimits } from './runtime.js';

/** One-shot private copier. The launcher binds both managed Linux volumes.
 * L1 and the preview app never receive the source mount or this control pipe. */
export function copyComputePreview(input: unknown, source = '/source/current', destination = '/preview/current') {
  const command = computePreviewCommandSchema.parse(input);
  if (command.method !== 'start') throw new Error('Expected preview start');
  if (command.source === 'delivered' && !command.artifactHash) throw new Error('Delivered preview requires a saved artifact identity');
  materializePreviewWorkspace({ sourceRoot: source, destinationRoot: destination, preserveExecutable: true,
    limits: previewCopyLimits(command.mode === 'terminal' ? 'terminal' : undefined, command.copyMaxBytes) });
  if (command.artifactHash) {
    const observed = buildWorkspaceArtifactManifest({ workspaceRoot: destination, allowEmpty: true,
      ...(command.delivery ? { delivery: command.delivery } : {}) }).manifest;
    if (artifactManifestHash(observed) !== command.artifactHash) throw new Error('Preview copy differs from the saved delivery');
  }
  if (command.mode === 'terminal') return { kind: 'node' as const, entry: 'terminal' };
  const classified = classifyDeliveredWorkspace(destination, { manifestRoot: source });
  if (classified.availability !== 'available' || !classified.kind || (classified.kind === 'node' && !classified.entry)) throw new Error('Preview copy is not runnable');
  return { kind: classified.kind, entry: classified.entry ?? 'index.html' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const raw = readFileSync(0);
    if (raw.length > 16384) throw new Error('Preview copy request too large');
    process.stdout.write(JSON.stringify(copyComputePreview(JSON.parse(raw.toString('utf8')))));
  } catch { process.exitCode = 1; }
}
