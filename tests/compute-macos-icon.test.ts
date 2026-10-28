import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it.skipIf(process.platform !== 'darwin')('decodes every shipped macOS icon representation, including Finder list sizes', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'atoma-icon-proof-'));
  try {
    const iconset = join(temporary, 'Atoma.iconset');
    execFileSync('iconutil', ['-c', 'iconset', resolve('desktop/atoma.icns'), '-o', iconset]);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const pixels = size * scale;
        const frame = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        const bitmap = join(temporary, 'frame.bmp');
        execFileSync('sips', ['-s', 'format', 'bmp', join(iconset, frame), '--out', bitmap], { stdio: 'pipe' });
        const bytes = readFileSync(bitmap);
        expect(bytes.toString('ascii', 0, 2), frame).toBe('BM');
        const width = bytes.readInt32LE(18);
        const height = bytes.readInt32LE(22);
        expect([width, Math.abs(height), bytes.readUInt16LE(28)], frame).toEqual([pixels, pixels, 32]);
        const offset = bytes.readUInt32LE(10);
        // Interior points of the three brand facets and the white center.
        // Decode pixels, rather than accepting a valid container with corrupt small frames.
        for (const [x, y, rgb] of [
          [0.5, 0.25, [245, 158, 11]], [0.34, 0.59, [15, 118, 110]],
          [0.66, 0.59, [124, 58, 237]], [0.5, 0.5, [248, 251, 255]],
        ] as const) {
          const row = height < 0 ? Math.floor(y * pixels) : pixels - 1 - Math.floor(y * pixels);
          const start = offset + (row * width + Math.floor(x * pixels)) * 4;
          const actual = [bytes.readUInt8(start + 2), bytes.readUInt8(start + 1), bytes.readUInt8(start)] as const;
          for (const channel of [0, 1, 2] as const) {
            expect(Math.abs(actual[channel] - rgb[channel]), `${frame} at ${x},${y}`).toBeLessThanOrEqual(16);
          }
          expect(bytes[start + 3], frame).toBe(255);
        }
      }
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
