import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import {
  ATTRIBUTION_BADGE_HTML,
  ATTRIBUTION_LABEL,
  attributionAppender,
  isAttributableRequest,
  isAttributableResponse,
} from '../src/preview/attribution.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

function find(node: Node, tag: string): Element | null {
  if ('tagName' in node && node.tagName === tag) return node;
  for (const child of 'childNodes' in node ? node.childNodes : []) {
    const hit = find(child, tag);
    if (hit) return hit;
  }
  return null;
}

async function appended(html: string): Promise<string> {
  return text(Readable.from([Buffer.from(html)]).pipe(attributionAppender()));
}

describe('the web badge', () => {
  it('lands in the body whatever the document already closed', async () => {
    for (const html of [
      '<!doctype html><html><head><title>t</title></head><body><main>app</main></body></html>\n',
      '<h1>no structure at all</h1>',
      '<!doctype html><html><body><p>unclosed',
    ]) {
      const output = await appended(html);
      expect(output.startsWith(html)).toBe(true);
      const document = parse(output);
      const badge = find(document, 'atoma-attribution');
      expect(badge?.parentNode && 'tagName' in badge.parentNode ? badge.parentNode.tagName : null).toBe(
        html.includes('unclosed') ? 'p' : 'body'
      );
    }
  });

  it('is self-contained: no script, no fetched resource, and nothing to click', () => {
    expect(ATTRIBUTION_BADGE_HTML).toContain(ATTRIBUTION_LABEL);
    expect(ATTRIBUTION_BADGE_HTML).toContain('shadowrootmode="open"');
    expect(ATTRIBUTION_BADGE_HTML).toContain('pointer-events:none');
    expect(ATTRIBUTION_BADGE_HTML).not.toMatch(/<script|<a\s|\ssrc=|href=|url\(/i);
  });
});

describe('which exchanges carry it', () => {
  it('only a browser loading a page', () => {
    expect(isAttributableRequest('GET', { 'sec-fetch-dest': 'document' })).toBe(true);
    expect(isAttributableRequest('GET', { 'sec-fetch-dest': 'iframe' })).toBe(true);
    expect(isAttributableRequest('POST', { 'sec-fetch-dest': 'document' })).toBe(true);
    expect(isAttributableRequest('HEAD', { 'sec-fetch-dest': 'document' })).toBe(false);
    // A fragment the page fetched for itself, and a non-browser client.
    expect(isAttributableRequest('GET', { 'sec-fetch-dest': 'empty' })).toBe(false);
    expect(isAttributableRequest('GET', {})).toBe(false);
  });

  it('only a complete HTML body it can append to unchanged', () => {
    expect(isAttributableResponse(200, { 'content-type': 'text/html; charset=utf-8' })).toBe(true);
    expect(isAttributableResponse(200, { 'content-type': 'TEXT/HTML', 'content-encoding': 'identity' })).toBe(true);
    expect(isAttributableResponse(206, { 'content-type': 'text/html' })).toBe(false);
    expect(isAttributableResponse(304, { 'content-type': 'text/html' })).toBe(false);
    expect(isAttributableResponse(200, { 'content-type': 'application/xhtml+xml' })).toBe(false);
    expect(isAttributableResponse(200, { 'content-type': 'text/html-sandboxed' })).toBe(false);
    expect(isAttributableResponse(200, { 'content-type': 'text/html; charset=UTF-16LE' })).toBe(false);
    expect(isAttributableResponse(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' })).toBe(false);
    expect(isAttributableResponse(200, { 'content-type': 'application/json' })).toBe(false);
    expect(isAttributableResponse(200, {})).toBe(false);
  });
});
