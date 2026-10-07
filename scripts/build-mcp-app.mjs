import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({ entryPoints: [join(root, 'src/mcp/app/browser.ts')], bundle: true,
  platform: 'browser', format: 'iife', target: 'es2022', minify: true, write: false });
const locales = ['en', 'zh', 'hi', 'es', 'ar', 'fr', 'bn', 'pt', 'id', 'ur', 'ru', 'de', 'ja'];
const copy = Object.fromEntries(locales.map(locale => {
  const catalog = JSON.parse(readFileSync(join(root, `src/viz/client/locales/${locale}.json`), 'utf8'));
  return [locale, { translation: Object.fromEntries(Object.entries(catalog).filter(([key, value]) => key.startsWith('mcpApp.') && typeof value === 'string' && value.trim())) }];
}));
const template = readFileSync(join(root, 'src/mcp/app/view.html'), 'utf8');
const html = template.replace('<!-- COPY -->', () => JSON.stringify(copy).replaceAll('<', '\\u003c'))
  .replace('<!-- SCRIPT -->', () => bundled.outputFiles[0].text.replaceAll('</script', '<\\/script'));
mkdirSync(join(root, 'dist/mcp'), { recursive: true });
writeFileSync(join(root, 'dist/mcp/run-app.html'), html);
console.log(`MCP App: ${Buffer.byteLength(html)} bytes, self-contained`);
