import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

// The viz server serves `<asset>.br` whenever it exists and the client accepts
// Brotli, so this list is the one place that decides what travels compressed.
// WebAssembly and glTF binaries are included because nothing downstream
// compresses them: a reverse proxy cannot tell a .glb from any other
// application/octet-stream. Formats that already carry their own compression
// (png, webp, pdf.js bcmap) are left alone.
export const PRECOMPRESSED_ASSET = /\.(?:[cm]?js|css|wasm|glb|ttf|svg)$/;

/** Write a Brotli sibling for every eligible file that it actually shrinks. */
export function precompressAssets(dir) {
  let compressed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      compressed += precompressAssets(path);
    } else if (entry.isFile() && PRECOMPRESSED_ASSET.test(entry.name)) {
      const bytes = readFileSync(path);
      const brotli = brotliCompressSync(bytes, {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: bytes.length },
      });
      if (brotli.length >= bytes.length) continue;
      writeFileSync(`${path}.br`, brotli);
      compressed += 1;
    }
  }
  return compressed;
}
