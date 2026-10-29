/** Human-readable release metadata; installer identities and feeds stay unchanged. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readContent } from './compute-desktop-content.mjs';

export function computeReleasePresentation({ repository, tag, version, revision, signed }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^\d+\.\d+\.\d+$/.test(version)
    || !/^[a-f0-9]{40}$/.test(revision) || typeof signed !== 'boolean'
    || !/^compute-desktop-(?:current|stable|(?:preview|signed)-[\w.-]+)$/.test(tag)) {
    throw new Error('Invalid Compute release identity');
  }
  const channel = tag === 'compute-desktop-current' || tag === 'compute-desktop-stable';
  const base = `https://github.com/${repository}/releases`;
  const download = suffix => `${base}/download/${tag}/Atoma-Compute-${version}-${suffix}`;
  const title = `Compute ${version} — ${channel ? 'downloads' : signed ? 'signed release' : 'preview'}`;
  const body = [
    `Atoma Compute **${version}** for macOS and Windows.`,
    ...(!channel ? [`[Get the current version](${base}/tag/compute-desktop-current) · [Installation guide](https://atoma.run/compute/setup)`] : ['[Installation guide](https://atoma.run/compute/setup)']),
    '## Download',
    `- [**Mac — Apple Silicon** (${version})](${download('mac-arm64.dmg')})`,
    `- [**Mac — Intel** (${version})](${download('mac-x64.dmg')})`,
    `- [**Windows — 64-bit** (${version})](${download('win-x64.exe')})`,
    'On a Mac, open **Apple menu → About This Mac**: “Chip” means Apple Silicon; “Processor: Intel” means Intel.',
    '## Install',
    'Docker Desktop is required. On Windows, use its WSL2 backend. Open Atoma Compute after installation and connect your account.',
    ...(signed ? ['These installers are signed; the macOS application is notarized. Updates are offered in the application.'] : [
      '**Unsigned preview:** macOS and Windows may block the first launch. Follow the [installation guide](https://atoma.run/compute/setup). On macOS, after attempting to open the app, use **System Settings → Privacy & Security → Open Anyway** if you trust the download.',
      'Updates require downloading and installing the new version manually.',
    ]),
    '## Other files',
    'The `.sha256` files verify downloads; they are not installers. GitHub’s “Source code” archives do not install Atoma Compute. The links above select this version directly; the Assets list may also contain download aliases and older versions.',
    '<details>\n<summary>Build details</summary>\n',
    `${signed ? 'Signed release' : 'Unsigned preview'} from ${revision}.`,
    `[Source revision](https://github.com/${repository}/commit/${revision}) · [Release history](${base})`,
    '</details>',
  ].join('\n\n') + '\n';
  return { title, body };
}

async function main() {
  const [receiptFile, tag, signed, repository, notesFile] = process.argv.slice(2);
  if (!receiptFile || !notesFile || !['0', '1'].includes(signed)) throw new Error('Expected receipt, tag, signing flag, repository and notes path');
  const receipt = readContent(await readFile(receiptFile, 'utf8'));
  const { title, body } = computeReleasePresentation({ repository, tag, signed: signed === '1', version: receipt.installerVersion, revision: receipt.revision });
  await writeFile(notesFile, body);
  process.stdout.write(title);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
