import type * as FileViewerLibrary from '@open-file-viewer/core';
import type { PdfPluginOptions, PreviewPlugin } from '@open-file-viewer/core';

/** Specialized decoders precede text; the terminal fallback must stay last. */
export function filePreviewPlugins(library: typeof FileViewerLibrary, workers: {
  modern: string; legacy: string;
}): PreviewPlugin[] {
  const pdf: PdfPluginOptions = {
    workerSrc: workers.modern, legacyWorkerSrc: workers.legacy,
    cMapUrl: '/vendor/file-viewer/pdfjs/cmaps/',
    standardFontDataUrl: '/vendor/file-viewer/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/file-viewer/pdfjs/wasm/',
  };
  return [
    library.imagePlugin(), library.audioPlugin(), library.videoPlugin(),
    library.pdfPlugin(pdf), library.officePlugin({ pdf }),
    library.epubPlugin(), library.xpsPlugin(), library.ofdPlugin(),
    library.emailPlugin(), library.drawingPlugin(), library.xmindPlugin(),
    library.cadPlugin({ libreDwg: {
      wasmBaseUrl: '/vendor/file-viewer/libredwg/wasm',
      workerModuleUrl: '/vendor/file-viewer/libredwg/dist/libredwg-web.js',
    } }),
    library.model3dPlugin(), library.gisPlugin(), library.assetPlugin(),
    library.archivePlugin(), library.textPlugin(), library.fallbackPlugin(),
  ];
}
