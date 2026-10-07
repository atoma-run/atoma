// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PreviewOptions } from '@open-file-viewer/core';
import { FilePreview } from '../src/viz/client-gl/FilePreview.js';
import { filePreviewTranslations } from '../src/viz/client-gl/file-preview-i18n.js';
import { translate } from '../src/viz/client/i18n-catalog.js';

const mocks = vi.hoisted(() => ({ destroy: vi.fn(), create: vi.fn(), fetch: vi.fn(), revoke: vi.fn() }));
vi.mock('@open-file-viewer/core', () => ({
  createViewer: (options: PreviewOptions) => { mocks.create(options); return { destroy: mocks.destroy }; },
  imagePlugin: () => ({ name: 'image' }), audioPlugin: () => ({ name: 'audio' }),
  videoPlugin: () => ({ name: 'video' }), pdfPlugin: () => ({ name: 'pdf' }),
  officePlugin: () => ({ name: 'office' }), textPlugin: () => ({ name: 'text' }),
  ...Object.fromEntries(['epub', 'xps', 'ofd', 'email', 'drawing', 'xmind', 'cad',
    'model3d', 'gis', 'asset', 'archive', 'fallback'].map(name => [`${name}Plugin`, () => ({ name })])),
}));
vi.mock('@open-file-viewer/core/style.css?inline', () => ({ default: '' }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.js' }));
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: '/legacy-worker.js' }));
vi.mock('leaflet/dist/leaflet.css?inline', () => ({ default: '' }));
const target = { projectId: 'project', runId: 'run', path: 'folder/hello #.wav' };
function mount() {
  vi.stubGlobal('fetch', mocks.fetch);
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:download', revokeObjectURL: mocks.revoke }));
  const onClose = vi.fn();
  const view = render(createElement(FilePreview, { target, locale: 'fr', t: key => key, onClose }));
  const frame = view.container.querySelector('iframe')!;
  frame.contentDocument!.body.innerHTML = '<div id="viewer"></div>';
  fireEvent.load(frame);
  return { ...view, frame, onClose };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('passes exact bytes to the shared decoder and destroys it and its download URL on close', async () => {
  const bytes = new Uint8Array([0, 255, 128, 1]).buffer;
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => bytes });
  const view = mount();
  await waitFor(() => expect(mocks.create).toHaveBeenCalledOnce());
  expect(mocks.fetch.mock.calls[0]![0]).toContain('format=bytes&path=folder%2Fhello%20%23.wav');
  const options = mocks.create.mock.calls[0]![0] as PreviewOptions;
  expect(options.file).toBe(bytes);
  expect(options.messages?.['textWrap']).toBe('fileViewer.message.textWrap');
  expect(typeof options.toolbar === 'object' && options.toolbar.titles?.search).toBe('fileViewer.titles.search');
  expect(view.frame.contentDocument!.documentElement.lang).toBe('fr');
  expect(options.plugins!.map(plugin => plugin.name)).toEqual(['image', 'audio', 'video', 'pdf', 'office',
    'epub', 'xps', 'ofd', 'email', 'drawing', 'xmind', 'cad', 'model3d', 'gis', 'asset', 'archive', 'text', 'fallback']);
  expect(view.frame.getAttribute('sandbox')).toBe('allow-same-origin allow-scripts');
  expect(view.frame.getAttribute('srcdoc')).toContain("script-src 'none'");
  fireEvent.keyDown(view.frame.contentWindow!, { key: 'Escape' });
  expect(view.onClose).toHaveBeenCalledOnce();
  view.unmount();
  expect(mocks.destroy).toHaveBeenCalledOnce();
  expect(mocks.revoke).toHaveBeenCalledWith('blob:download');
});
it('localizes toolbar controls and preserves reader interpolation tokens', () => {
  const t = vi.fn((key: string, vars?: Record<string, unknown>) => `localized:${translate('en', key, vars)}`);
  const { messages, toolbar } = filePreviewTranslations(t);
  expect(messages.textLineCount).toBe('localized:{count} lines');
  expect(messages.pdfPageLabel).toBe('localized:Page {page}');
  expect(messages.textWrap).toBe('localized:Wrap');
  expect(toolbar.labels?.['rotate-right']).toBe('localized:Rotate');
  expect(toolbar.titles?.search).toBe('localized:Search preview text');
  expect(filePreviewTranslations((key, vars) => translate('fr', key, vars)).messages.textCopy).toBe('Copier');
});
it.each([413, 403, 409])('surfaces HTTP %i without sending unavailable bytes to a decoder', async status => {
  mocks.fetch.mockResolvedValue({ ok: false, status });
  mount();
  await waitFor(() => expect(screen.getByRole('status').textContent)
    .toBe(status === 413 ? 'workspace.previewTooLarge' : 'workspace.unavailable'));
  expect(mocks.create).not.toHaveBeenCalled();
});
it('keeps the file downloadable and reports a reader failure when initialization fails', async () => {
  const error = new Error('Decoder module unavailable');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.fetch.mockResolvedValue({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(4) });
  mocks.create.mockImplementationOnce(() => { throw error; });
  try {
    mount();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('workspace.previewFailed'));
    expect(screen.getByRole('link', { name: 'workspace.download' }).getAttribute('href')).toBe('blob:download');
    expect(log).toHaveBeenCalledWith('[file-preview] Preview initialization failed', error);
  } finally { log.mockRestore(); }
});
it('aborts a pending file read when the reader closes', () => {
  mocks.fetch.mockImplementation(() => new Promise(() => {}));
  const view = mount();
  const options = mocks.fetch.mock.calls[0]![1] as RequestInit;
  view.unmount();
  expect(options.signal!.aborted).toBe(true);
  expect(mocks.create).not.toHaveBeenCalled();
});
