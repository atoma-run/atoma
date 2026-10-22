import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Run after the publication job verifies the three versioned installers and
// their checksums. Stable aliases let the website follow native CI versions.
const directory = resolve(process.argv[2] ?? 'installers');
const files = await readdir(directory);
const aliases = ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'];
const copies = await Promise.all(aliases.map(async suffix => {
  const matches = files.filter(name => /^Atoma-Compute-\d+\.\d+\.\d+-/.test(name) && name.endsWith(`-${suffix}`));
  if (matches.length !== 1) throw new Error(`Expected one verified installer for ${suffix}`);
  const source = matches[0];
  const checksum = await readFile(join(directory, `${source}.sha256`), 'utf8');
  const hash = /^([a-f0-9]{64})\s+/.exec(checksum)?.[1];
  if (!hash) throw new Error(`Missing verified checksum for ${source}`);
  return { source, alias: `Atoma-Compute-${suffix}`, hash };
}));
for (const { source, alias, hash } of copies) {
  await copyFile(join(directory, source), join(directory, alias));
  await writeFile(join(directory, `${alias}.sha256`), `${hash}  ${alias}\n`);
}
