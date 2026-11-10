import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

// Resolve the decoder exactly as the shipped reader does, including overrides.
const require = createRequire(import.meta.url);
const readerRequire = createRequire(require.resolve('@open-file-viewer/core'));
const { readPsd } = readerRequire('ag-psd') as typeof import('ag-psd');

function layeredPsd(side: number): Buffer {
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const section = (b: Buffer) => Buffer.concat([u32(b.length), b]);
  const layer = Buffer.concat([
    u32(0), u32(0), u32(side), u32(side), u16(0),
    Buffer.from('8BIMnorm'), Buffer.from([255, 0, 0, 0]), u32(0),
  ]);
  return Buffer.concat([
    Buffer.from('8BPS'), u16(1), Buffer.alloc(6),
    u16(3), u32(1), u32(1), u16(16), u16(3),
    section(Buffer.alloc(0)), section(Buffer.alloc(0)),
    section(section(Buffer.concat([u16(1), layer]))), u16(0), Buffer.alloc(6),
  ]);
}

it('enforces totalMemoryLimit on layer allocation in the reader dependency (GHSA-6w3r-6hpr-hp6p)', () => {
  // A 16x16 16-bit RGBA layer requires 2 KiB; even the vulnerable decoder
  // allocates only that tiny buffer, so the regression is safe to run unfixed.
  expect(() => readPsd(layeredPsd(16), {
    useImageData: true, skipCompositeImageData: true, totalMemoryLimit: 1024,
  })).toThrow(/memory limit/i);
});

it('still decodes a layer below the requested memory limit', () => {
  const psd = readPsd(layeredPsd(8), {
    useImageData: true, skipCompositeImageData: true, totalMemoryLimit: 1024,
  });
  expect(psd.children?.[0]?.imageData).toMatchObject({ width: 8, height: 8 });
  expect(psd.children?.[0]?.imageData?.data.byteLength).toBe(512);
});
