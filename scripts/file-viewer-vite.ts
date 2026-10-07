import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/** Host optional decoder assets in both Vite development and packaged builds. */
export function fileViewerAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const transformViewer = (code: string, id: string) => {
    if (!id.replaceAll('\\', '/').endsWith('/@open-file-viewer/core/dist/index.js')) return;
    // Upstream hides this optional import inside new Function, which Vite
    // cannot resolve. Make it a real lazy chunk, without mutating node_modules.
    const loader = 'var loadMpegts = () => importOptionalModule(mpegtsPackageName);';
    if (!code.includes(loader)) throw new Error('Open File Viewer optional video loader changed; review the bundler adapter');
    return { code: code.replace(loader, 'var loadMpegts = () => import("mpegts.js");')
      .replace('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css', '/vendor/file-viewer/leaflet.css'), map: null };
  };
  return {
    name: 'atoma-file-viewer-assets',
    enforce: 'pre',
    config() {
      // Core's CommonJS dependencies need prebundling in development. Apply
      // the same compatibility transform there instead of excluding core.
      return { optimizeDeps: {
        include: ['@open-file-viewer/core'],
        rolldownOptions: { plugins: [{ name: 'atoma-file-viewer-dependency-compat', transform: transformViewer }] },
      } };
    },
    configResolved(config) {
      const target = join(config.publicDir, 'vendor/file-viewer');
      const pdf = dirname(require.resolve('pdfjs-dist/package.json'));
      const dwg = dirname(dirname(require.resolve('@mlightcad/libredwg-web')));
      mkdirSync(target, { recursive: true });
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        cpSync(join(pdf, dir), join(target, 'pdfjs', dir), { recursive: true });
      }
      cpSync(join(pdf, 'LICENSE'), join(target, 'pdfjs/LICENSE'));
      for (const dir of ['dist', 'wasm']) {
        cpSync(join(dwg, dir), join(target, 'libredwg', dir), { recursive: true });
      }
      // Preserve the upstream source location, version and GPL license notice.
      for (const name of ['README.md', 'package.json']) {
        cpSync(join(dwg, name), join(target, 'libredwg', name));
      }
      cpSync(require.resolve('leaflet/dist/leaflet.css'), join(target, 'leaflet.css'));
    },
    transform: transformViewer,
  };
}
