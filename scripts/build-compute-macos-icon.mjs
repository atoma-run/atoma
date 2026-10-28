/** Rebuild the checked-in macOS icon with Apple's native, lossless ICNS encoder. */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('The macOS icon requires sips and iconutil');
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'atoma-native-icon-'));
try {
  const iconset = join(temporary, 'Atoma.iconset');
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      execFileSync('sips', ['-z', String(size * scale), String(size * scale),
        join(root, 'src/viz/public/icons/atoma-512.png'), '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'pipe' });
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'desktop/atoma.icns')], { stdio: 'pipe' });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
