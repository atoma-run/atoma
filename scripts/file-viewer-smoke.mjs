/* global document, window, createImageBitmap */
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview, createServer } from 'vite';
import puppeteer from 'puppeteer';
import { fileViewerFixtures } from './file-viewer-fixtures.mjs';

// Compile the real shared reader with the application's Vite configuration,
// in an isolated output directory. Other builds cannot replace its lazy chunks.
const repo = fileURLToPath(new URL('..', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'atoma-file-viewer-'));
let server;
let browser;
try {
  await symlink(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, 'index.html'), '<div id="root"></div><script type="module" src="/entry.js"></script>');
  await writeFile(join(root, 'entry.js'), `
    import React, { useState, useCallback } from 'react';
    import { createRoot } from 'react-dom/client';
    import { FilePreview } from ${JSON.stringify(join(repo, 'src/viz/client-gl/FilePreview.tsx'))};
    import { AtomaCursor } from ${JSON.stringify(join(repo, 'src/viz/client-gl/AtomaCursor.tsx'))};
    import { translate } from ${JSON.stringify(join(repo, 'src/viz/client/i18n-catalog.ts'))};
    import ${JSON.stringify(join(repo, 'src/viz/client-gl/styles.css'))};
    function App() {
      const [path, setPath] = useState(null);
      const [locale, setLocale] = useState('fr');
      window.setReaderLocale = setLocale;
      const t = useCallback((key, vars) => translate(locale, key, vars), [locale]);
      window.showFile = setPath;
      return React.createElement(React.Fragment, null, React.createElement(AtomaCursor),
        path && React.createElement(FilePreview, { key: path,
          target: { projectId: 'p', runId: 'r', path }, t, locale,
          onClose: () => setPath(null) }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(App));
  `);
  const config = { configFile: join(repo, 'vite.config.ts'), root,
    build: { outDir: join(root, 'dist'), emptyOutDir: true }, logLevel: 'warn' };
  if (process.argv.includes('--dev')) {
    server = await createServer({ ...config, server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
  } else {
    await build(config);
    server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
  }
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  // Headless Chrome has no physical mouse; exercise the desktop cursor mode.
  await page.evaluateOnNewDocument(() => {
    const match = window.matchMedia.bind(window);
    window.matchMedia = query => match(query === '(any-hover: hover) and (any-pointer: fine)' ? '(min-width: 0px)' : query);
  });
  await page.setViewport({ width: 1200, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const fixtures = await fileViewerFixtures();
  Object.assign(fixtures, {
    'app.js': { bytes: 'export const greeting = "hello";', selector: '.ofv-code-container', text: 'export const greeting' },
    'sample.csv': { bytes: 'name,value\nAtoma,42', selector: 'td', text: 'Atoma' },
    'sample.md': { bytes: '# Rendered Markdown', selector: 'h1', text: 'Rendered Markdown' },
    'sample.svg': { bytes: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>', selector: 'img', text: '' },
  });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/workspace')) {
      const fixture = fixtures[url.searchParams.get('path')];
      void request.respond({ status: fixture ? 200 : 404, contentType: 'application/octet-stream', body: fixture?.bytes ?? '' });
    } else void request.continue();
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.showFile === 'function');
  for (const [path, fixture] of Object.entries(fixtures)) {
    await page.evaluate(path => window.showFile(path), path);
    await page.waitForFunction(() => document.querySelector('iframe') && !document.querySelector('.gpu-preview-status')).catch(async error => {
      throw new Error(`File preview ${path}: ${await page.locator('.gpu-preview-status').map(el => el.textContent).wait()}\n${errors.join('\n')}`, { cause: error });
    });
    await page.waitForFunction(({ selector, text }) => {
      const doc = document.querySelector('iframe')?.contentDocument;
      return [...(doc?.querySelectorAll(selector) ?? [])].some(el => el.textContent.includes(text));
    }, {}, { selector: fixture.selector, text: fixture.text });
    const png = await page.screenshot({ path: `/tmp/atoma-reader-${path.replaceAll(/[/.]/g, '-')}.png`, encoding: 'base64' });
    if (fixture.selector === '.ofv-model-stage canvas') {
      // Read the composited screenshot, not the WebGL buffer: sandbox flags
      // previously left the on-screen canvas blank despite valid readback.
      const visible = await page.evaluate(async png => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
        const copy = document.createElement('canvas'); copy.width = bitmap.width; copy.height = bitmap.height;
        const context = copy.getContext('2d'); context.drawImage(bitmap, 0, 0);
        const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
        let bright = 0;
        for (let y = Math.floor(copy.height / 2); y < copy.height - 60; y++) {
          for (let x = 100; x < copy.width - 100; x++) {
            const i = (y * copy.width + x) * 4;
            if (pixels[i] > 200 && pixels[i + 1] > 200 && pixels[i + 2] > 200) bright++;
          }
        }
        bitmap.close();
        return bright;
      }, png);
      if (visible < 10000) throw new Error(`3D canvas is not composited: ${visible} visible pixels`);
    }
    console.log(`File preview rendered: ${path}`);
    if (path === 'app.js') {
      const bounds = await page.$eval('iframe', frame => {
        const rect = frame.getBoundingClientRect();
        return { x: rect.left + 250, y: rect.top + 120 };
      });
      await page.mouse.move(bounds.x, bounds.y);
      await page.mouse.click(bounds.x, bounds.y);
      await page.waitForFunction(({ x, y }) => {
        const cursor = document.querySelector('.atoma-pointer-cursor');
        const doc = document.querySelector('iframe').contentDocument;
        return cursor.dataset.visible === 'true' && Math.abs(Number(cursor.dataset.x) - x) < 1 &&
          Math.abs(Number(cursor.dataset.y) - y) < 1 && doc.defaultView.getComputedStyle(doc.body).cursor === 'none';
      }, {}, bounds);
      const localized = await page.evaluate(() => {
        const doc = document.querySelector('iframe').contentDocument;
        return doc.documentElement.lang === 'fr' && [...doc.querySelectorAll('button')].some(button => button.textContent === 'Copier');
      });
      if (!localized) throw new Error('Reader did not use the client French copy label');
      await page.evaluate(() => window.setReaderLocale('ar'));
      await page.waitForFunction(() => {
        const doc = document.querySelector('iframe')?.contentDocument;
        return !document.querySelector('.gpu-preview-status') && doc?.documentElement.lang === 'ar' && doc.documentElement.dir === 'rtl';
      });
      await page.evaluate(() => window.setReaderLocale('fr'));
      await page.waitForFunction(() => !document.querySelector('.gpu-preview-status'));
      console.log('Reader cursor crosses the iframe, survives focus, and follows the client locale');
    }
    await page.click('.gpu-preview-actions button');
    await page.waitForFunction(() => !document.querySelector('iframe'));
  }
  if (errors.length) throw new Error(`File preview browser errors: ${errors.join('\n')}`);
  // Deliberately attempt execution in the output document. Parent callbacks
  // are trusted, but neither a file's script element nor inline handler may run.
  await page.evaluate(() => window.showFile('sample.md'));
  await page.waitForFunction(() => document.querySelector('iframe') && !document.querySelector('.gpu-preview-status'));
  const blocked = await page.evaluate(async () => {
    const doc = document.querySelector('iframe').contentDocument;
    const violations = [];
    doc.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
    const script = doc.createElement('script');
    script.textContent = 'parent.__filePreviewExecuted = true';
    doc.body.append(script);
    const button = doc.createElement('button');
    button.setAttribute('onclick', 'parent.__filePreviewExecuted = true');
    doc.body.append(button); button.click();
    await new Promise(resolve => setTimeout(resolve, 100));
    return { executed: window.__filePreviewExecuted === true, violations };
  });
  if (blocked.executed || !blocked.violations.includes('script-src-elem') || !blocked.violations.includes('script-src-attr')) {
    throw new Error(`File-authored script isolation failed: ${JSON.stringify(blocked)}`);
  }
  console.log('File preview CSP rejected script elements and inline event handlers');
  console.log(`File preview browser smoke passed: ${Object.keys(fixtures).length} real files`);
} finally {
  await browser?.close();
  if (server?.close) await server.close();
  else await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve());
  await rm(root, { recursive: true, force: true });
}
