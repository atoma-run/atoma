import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hostingManifestSchema } from '../contracts/projectHosting.js';
import type { ArtifactManifest } from '../contracts/projects.js';

/** Only declared, hash-bound bytes may opt an accepted delivery into browser hosting. */
export function readHostingManifest(root: string, manifest: ArtifactManifest | null) {
  const file = manifest?.files.find(f => f.path === 'atoma.hosting.json');
  if (!file) return null;
  const target = path.join(root, file.path);
  const stat = lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid hosting manifest');
  const bytes = readFileSync(target);
  if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Changed hosting manifest');
  const config = hostingManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (!manifest!.files.some(f => f.path === config.entry)) throw new Error('Hosting entry is not published');
  return config;
}
