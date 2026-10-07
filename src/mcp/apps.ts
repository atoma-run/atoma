import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { repoRoot } from './run.js';

export const RUN_APP_URI = 'ui://atoma/run.html';
/** Hosts negotiate the UI extension; others ignore this metadata and keep the full text result. */
export const RUN_APP_META = { ui: { resourceUri: RUN_APP_URI }, 'ui/resourceUri': RUN_APP_URI };

export function registerRunApp(server: McpServer): void {
  const ui = { prefersBorder: true, csp: { connectDomains: [], resourceDomains: ['blob:'], frameDomains: [] } };
  registerAppResource(server, 'atoma-run-view', RUN_APP_URI, { title: 'Atoma run', _meta: { ui } }, () => {
    let html: string;
    try { html = readFileSync(join(repoRoot(), 'dist/mcp/run-app.html'), 'utf8'); }
    catch { throw new Error('The run view is unavailable. Use the text result; ask the instance administrator to rebuild the MCP App.'); }
    return { contents: [{ uri: RUN_APP_URI, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui } }] };
  });
}
