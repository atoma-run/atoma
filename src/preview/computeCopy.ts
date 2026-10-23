import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePreviewCommandSchema } from '../contracts/computePreview.js';
import { materializePreviewWorkspace } from './policy.js';
import { classifyDeliveredWorkspace, usableNodeEntry } from './descriptor.js';
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
  // A delivered copy whose bytes matched the saved delivery above is described
  // by the host's descriptor, not re-classified here: the device's probe
  // manifest is not the host's (a Compute export carries only publishable
  // files), so a run that never restarted its server re-classified as
  // unsupported although its descriptor names the entry (Attica 84ae80d1,
  // 2026-10-23). The entry must still be a usable file in THIS copy.
  if (command.classification && command.source === 'delivered' && command.artifactHash) {
    const described = command.classification;
    if (described.kind === 'node') {
      const entry = usableNodeEntry(destination, described.entry);
      if (!entry) throw new Error('Preview copy is not runnable');
      return { kind: 'node' as const, entry };
    }
    return { kind: 'static' as const, entry: 'index.html' };
  }
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
