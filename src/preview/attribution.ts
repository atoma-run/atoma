import { Transform } from 'node:stream';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * THE ATOMA MARK ON WHAT A RUN PRODUCED.
 *
 * Every surface where Atoma serves a delivered application says so, once and
 * quietly: a corner badge on a web page, one line above a CLI's first prompt,
 * a description on a repository Atoma creates. One home for the wording, so
 * the three cannot drift.
 *
 * IT IS ADDED BY THE HOST, NEVER WRITTEN INTO THE DELIVERABLE. The delivered
 * workspace is what the run verified and what the next run seeds from; a
 * footer committed into it would be a change nobody verified, would reach the
 * tenant's repository, and would be one the next run could delete or
 * duplicate. The gateways append it to what they serve instead.
 */

export const ATTRIBUTION_LABEL = 'Powered by Atoma';

/** A repository Atoma creates; an existing repository keeps its own. */
export const ATTRIBUTION_REPOSITORY_DESCRIPTION = 'Built with Atoma · https://atoma.run';

/** The brand mark (`src/viz/public/favicon.svg`), flattened for inlining. */
const MARK =
  '<svg viewBox="0 0 512 512" aria-hidden="true" focusable="false">' +
  '<path d="M256 52 452 256 60 256Z" fill="#f59e0b"/>' +
  '<path d="M60 256 256 256 256 460Z" fill="#0f766e"/>' +
  '<path d="M452 256 256 460 256 256Z" fill="#7c3aed"/>' +
  '<path d="M256 200 316 256 256 312 196 256Z" fill="#f8fbff"/>' +
  '</svg>';

/**
 * The web badge.
 *
 * - A DECLARATIVE SHADOW ROOT, so the application's stylesheet cannot restyle
 *   it and its own cannot leak into the application — without a script. A
 *   browser that predates declarative shadow DOM shows nothing, which is the
 *   right failure for something meant to be discreet.
 * - `pointer-events: none`: fixed in a corner, it would otherwise sit on top
 *   of whatever control the application put there. It is a mark, not a link:
 *   the gateways' CSP sandbox has no `allow-popups`, and navigating a preview
 *   frame to another site lands on that site's framing refusal — a link that
 *   fails after the click is worse than none.
 * - Everything inline and nothing fetched, so it holds under the gateways'
 *   `default-src 'self'` and their `'unsafe-inline'` style allowance.
 */
export const ATTRIBUTION_BADGE_HTML =
  '<atoma-attribution style="all:initial;position:fixed;right:8px;bottom:8px;' +
  'z-index:2147483647;pointer-events:none">' +
  '<template shadowrootmode="open"><style>' +
  'span{display:inline-flex;align-items:center;gap:5px;padding:3px 8px 3px 6px;' +
  'border-radius:999px;background:rgba(15,23,42,.6);color:#f8fafc;opacity:.75;' +
  'box-shadow:0 0 0 1px rgba(248,250,252,.14);' +
  'font:500 11px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
  'letter-spacing:.01em;white-space:nowrap}' +
  'svg{width:12px;height:12px;flex:none}' +
  '@media print{span{display:none}}' +
  `</style><span>${MARK}${ATTRIBUTION_LABEL}</span></template></atoma-attribution>`;

/**
 * The terminal banner, printed before the shell's first prompt. Truecolor
 * because the preview terminal is xterm.js; CRLF because it is a terminal.
 */
export const ATTRIBUTION_TERMINAL_BANNER =
  `\x1b[38;2;245;158;11m◆\x1b[0m \x1b[2m${ATTRIBUTION_LABEL} · atoma.run\x1b[0m\r\n\r\n`;

/**
 * Is this request a browser loading a page, rather than a script fetching one?
 *
 * Only a navigation gets the badge. An HTML fragment fetched by the page's own
 * code (htmx, Turbo, a template) is spliced into a document that already has
 * one, and a second badge inside a list item is damage. `Sec-Fetch-Dest` is
 * the browser's own statement of that difference; a client that sends none is
 * not a browser rendering the page, and gets the bytes unchanged.
 */
export function isAttributableRequest(method: string | undefined, headers: IncomingHttpHeaders): boolean {
  if (method === 'HEAD') return false;
  const dest = headers['sec-fetch-dest'];
  return dest === 'document' || dest === 'iframe';
}

/**
 * Can the badge be appended to this response's body as is?
 *
 * Only a complete (200) HTML body the gateway can read: XHTML is parsed as
 * XML, where anything after the root element is a fatal error; a compressed
 * body cannot be appended to without decoding it; UTF-16 would need the
 * badge re-encoded. Everything else passes through byte-identical.
 */
export function isAttributableResponse(status: number | undefined, headers: IncomingHttpHeaders): boolean {
  if (status !== 200) return false;
  const type = String(headers['content-type'] ?? '').toLowerCase();
  if (!/^text\/html\s*(;|$)/.test(type) || /charset\s*=\s*"?utf-16/.test(type)) return false;
  const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
  return encoding === '' || encoding === 'identity';
}

/**
 * Append the badge after the last byte of the document.
 *
 * Appending, not searching for `</body>`, so a page is never buffered: the
 * HTML parser moves content found after `</body>` or `</html>` into the body
 * (WHATWG "after body" insertion modes), and a document without either tag
 * simply ends in the badge.
 */
export function attributionAppender(): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, done) { done(null, chunk); },
    flush(done) { done(null, Buffer.from(ATTRIBUTION_BADGE_HTML, 'utf8')); },
  });
}
