import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('publishes stable links and matching checksum filenames from versioned CI installers', () => {
  const directory = mkdtempSync(join(tmpdir(), 'compute-downloads-'));
  const script = resolve('scripts/compute-desktop-aliases.mjs');
  const suffixes = ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe'];
  try {
    for (const suffix of suffixes) {
      const name = `Atoma-Compute-0.4.66-${suffix}`;
      const bytes = `installer ${suffix}`;
      writeFileSync(join(directory, name), bytes);
      writeFileSync(join(directory, `${name}.sha256`), `${createHash('sha256').update(bytes).digest('hex')}  ${name}\n`);
    }
    // The script runs as it does in publication, outside the repository cwd.
    execFileSync(process.execPath, [script, directory], { cwd: directory });
    for (const suffix of suffixes) {
      const alias = `Atoma-Compute-${suffix}`;
      const bytes = readFileSync(join(directory, alias));
      expect(bytes.toString()).toBe(`installer ${suffix}`);
      expect(readFileSync(join(directory, `${alias}.sha256`), 'utf8')).toBe(`${createHash('sha256').update(bytes).digest('hex')}  ${alias}\n`);
    }
    // Rerunning ignores its aliases rather than treating them as new inputs.
    execFileSync(process.execPath, [script, directory], { cwd: directory });
    writeFileSync(join(directory, 'Atoma-Compute-0.4.67-mac-arm64.dmg'), 'another build');
    expect(() => execFileSync(process.execPath, [script, directory], { cwd: directory, stdio: 'pipe' })).toThrow();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
