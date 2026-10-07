// Keep the reader lazy, but make CSS imports static inside this module. Vite
// development serves a dynamic `import('style.css?inline')` as text/css rather
// than a JavaScript module; static imports receive its required ?import marker.
import * as library from '@open-file-viewer/core';
import styles from '@open-file-viewer/core/style.css?inline';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import pdfLegacyWorker from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import mapStyles from 'leaflet/dist/leaflet.css?inline';

export { library, styles, pdfWorker, pdfLegacyWorker, mapStyles };
