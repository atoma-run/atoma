import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory = resolve(import.meta.dirname, '../dist/compute-installers');
for (const name of await readdir(directory)) {
  if (!/\.(dmg|zip|exe|blockmap|yml)$/.test(name) || name === 'builder-debug.yml' || name === 'builder-effective-config.yaml') continue;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
  await writeFile(join(directory, `${name}.sha256`), `${hash.digest('hex')}  ${name}\n`);
}
