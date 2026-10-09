import type { FilePreviewTarget } from './workspace-browser.js';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { FileViewer } from '@open-file-viewer/core';
import { MAX_WORKSPACE_FILE_BYTES } from '../../contracts/workspaceBrowser.js';
import { ButtonIcon } from './ButtonIcon.js';
import { filePreviewPlugins } from './file-preview-plugins.js';
import { filePreviewTranslations } from './file-preview-i18n.js';
import { connectPointerFrame } from './pointer-frame.js';
import { localeDirection, type Locale } from '../../contracts/locales.js';

// The trusted library runs in the parent, but its output lives in a document
// that cannot execute file-authored scripts (CSP) or navigate the parent
// (sandbox). Chrome suppresses canvas composition without allow-scripts, even
// when trusted parent code paints the canvas. script-src 'none' remains the
// execution boundary. The only remote images are the fixed GIS basemap.
const DOCUMENT = `<!doctype html><html style="height:100%;background:#0b101f"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; img-src blob: data: https://*.tile.openstreetmap.org; media-src blob: data:; frame-src blob:; style-src 'unsafe-inline'; font-src blob: data:; base-uri 'none'; form-action 'none'">
</head><body style="margin:0;height:100%"><div id="viewer" style="height:100vh"></div></body></html>`;

/**
 * A modal over the inert scene, or — `docked` — the Files section's second
 * column beside the GPU list, so the next file is one click away. Docked, it
 * is a region, not a dialog: it neither takes focus nor claims Escape from
 * the page, and one mount reads file after file in the same document.
 */
export function FilePreview({ target, t, locale, onClose, docked }: {
  target: FilePreviewTarget;
  t: (key: string, vars?: Record<string, unknown>) => string;
  locale: Locale;
  onClose: () => void;
  docked?: { readerX: number; veiled: boolean };
}) {
  const isDocked = !!docked;
  const frame = useRef<HTMLIFrameElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [documentReady, setDocumentReady] = useState(false);
  const [status, setStatus] = useState('workspace.loading');
  const [download, setDownload] = useState<string | null>(null);
  useEffect(() => {
    if (documentReady && frame.current) return connectPointerFrame(frame.current);
  }, [documentReady]);
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!documentReady || !doc) return;
    doc.documentElement.lang = locale;
    doc.documentElement.dir = localeDirection(locale);
  }, [documentReady, locale]);
  useEffect(() => {
    if (isDocked) return;
    const previous = document.activeElement;
    close.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [isDocked]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    if (!isDocked) window.addEventListener('keydown', escape);
    const child = frame.current?.contentWindow;
    const blockNavigation = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (anchor && !anchor.getAttribute('href')?.startsWith('#')) event.preventDefault();
    };
    const childDocument = child?.document;
    childDocument?.addEventListener('click', blockNavigation, true);
    child?.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); child?.removeEventListener('keydown', escape); childDocument?.removeEventListener('click', blockNavigation, true); };
  }, [onClose, documentReady, isDocked]);
  useEffect(() => {
    if (!documentReady) return;
    const controller = new AbortController();
    let viewer: FileViewer | undefined;
    let viewerStyle: HTMLStyleElement | undefined;
    let url: string | undefined;
    let failureStatus = 'workspace.unavailable';
    setStatus('workspace.loading');
    setDownload(null);
    void (async () => {
      const endpoint = `/api/projects/${encodeURIComponent(target.projectId)}/runs/${encodeURIComponent(target.runId)}/workspace?format=bytes&path=${encodeURIComponent(target.path)}`;
      const response = await fetch(endpoint, { signal: controller.signal, credentials: 'same-origin' });
      if (response.status === 413) { setStatus('workspace.previewTooLarge'); return; }
      if (!response.ok) throw new Error('File unavailable');
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES) { setStatus('workspace.previewTooLarge'); return; }
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      setDownload(url);
      failureStatus = 'workspace.previewFailed';
      const { library, styles, pdfWorker, pdfLegacyWorker, mapStyles } = await import('./file-preview-runtime.js');
      if (controller.signal.aborted) return;
      const doc = frame.current?.contentDocument;
      const container = doc?.getElementById('viewer');
      if (!doc || !container) return;
      const style = doc.createElement('style');
      viewerStyle = style;
      style.textContent = `${styles}\n${mapStyles}`;
      doc.head.append(style);
      const translations = filePreviewTranslations(t);
      viewer = library.createViewer({ container, file: bytes, fileName: target.path, height: '100%',
        theme: 'dark', locale: locale === 'zh' ? 'zh-CN' : 'en-US',
        plugins: filePreviewPlugins(library, { modern: pdfWorker, legacy: pdfLegacyWorker }),
        toolbar: { zoom: true, rotate: true, search: true, download: false, print: false, fullscreen: false,
          ...translations.toolbar },
        messages: translations.messages,
        onLoad: () => {
          // The font plugin loads faces in its own realm; render them in the
          // script-disabled output document as well.
          document.fonts?.forEach(face => doc.fonts?.add(face));
          if (!controller.signal.aborted) setStatus('');
        },
        onUnsupported: () => { if (!controller.signal.aborted) setStatus('workspace.unsupported'); },
        onError: () => { if (!controller.signal.aborted) setStatus('workspace.previewFailed'); },
      });
    })().catch(error => {
      if (!controller.signal.aborted) {
        if (failureStatus === 'workspace.previewFailed') console.error('[file-preview] Preview initialization failed', error);
        setStatus(failureStatus);
      }
    });
    return () => { controller.abort(); viewer?.destroy(); viewerStyle?.remove(); if (url) URL.revokeObjectURL(url); };
  }, [target, t, locale, documentReady]);
  const plane = <section className="gpu-preview-plane" role={docked ? 'region' : 'dialog'} aria-modal={docked ? undefined : true}
    aria-label={t('workspace.preview')} onKeyDown={docked ? event => { if (event.key === 'Escape') onClose(); } : undefined}>
      <header className="gpu-preview-chrome">
        <div className="gpu-preview-identity"><strong>{target.path}</strong><span>{t('workspace.snapshot')}</span></div>
        <div className="gpu-preview-actions">
          {download && <a href={download} download={target.path.split('/').pop()}>{t('workspace.download')}</a>}
          <button type="button" ref={close} onClick={onClose}><ButtonIcon kind="back" />{t('workspace.close')}</button>
        </div>
      </header>
      {status && <p className="gpu-preview-status" role="status">{t(status)}</p>}
      <div className="gpu-preview-stage"><iframe ref={frame} className="gpu-preview-frame" title={target.path} sandbox="allow-same-origin allow-scripts"
        referrerPolicy="no-referrer" srcDoc={DOCUMENT} onLoad={() => setDocumentReady(true)} /></div>
    </section>;
  // Docked, the wrapper is transparent and the view draws the frame
  // (`drawWorkspace`); it takes the menu veil like every other view overlay.
  return docked
    ? <div className={`gpu-workspace-reader${docked.veiled ? ' gpu-overlays-veiled' : ''}`} inert={docked.veiled}
      style={{ '--gpu-workspace-reader-x': `${docked.readerX}px` } as CSSProperties}>{plane}</div>
    : <div className="gpu-preview-backdrop">{plane}</div>;
}
