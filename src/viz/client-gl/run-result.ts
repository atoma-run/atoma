import { GROUND_TRUTH_MARKER } from '../../contracts/scriptEnvelope.js';
import type { VizProjectRun, VizRun } from '../client/types.js';

/**
 * The text parts of an answer aggregated by concatenation, nested at any
 * depth (an L3 concat over L2 concats); null as soon as one part is not text.
 */
function textParts(output: unknown): string[] | null {
  if (!Array.isArray(output) || output.length === 0) return null;
  const parts: string[] = [];
  for (const part of output) {
    if (typeof part === 'string') parts.push(part);
    else {
      const nested = textParts(part);
      if (!nested) return null;
      parts.push(...nested);
    }
  }
  return parts;
}

/** Only the persisted final output is a delivery; intermediate events are not. */
export function resultText(run: VizRun | null): string | null {
  const output = run?.result?.output;
  if (output === undefined || output === null) return null;
  if (typeof output === 'string') return output;
  // Copy and export read text as text, not as its JSON encoding.
  const parts = textParts(output);
  if (parts) return parts.filter(part => part.trim()).join('\n\n');
  return JSON.stringify(output, null, 2);
}

export function resultSections(run: VizRun): { title: string; text: string }[] {
  const output = run.result?.output;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return Object.entries(output).map(([title, value]) => ({
      title, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }));
  }
  const text = resultText(run);
  return text === null ? [] : [{ title: '', text }];
}

/** Prose for the reader; the complete structured output stays in details/export. */
export function resultNarrative(run: VizRun): { title: string; text: string }[] {
  const output = run.result?.output;
  if (typeof output === 'string') return [{ title: '', text: output }];
  // Concatenated phases of a text delivery: one answer in parts.
  const parts = textParts(output);
  if (parts) return parts.filter(part => part.trim()).map(text => ({ title: '', text }));
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return Object.entries(output).flatMap(([title, value]) =>
      typeof value === 'string' && value.trim() ? [{ title, text: value }] : []);
  }
  return [];
}

/**
 * A summary is what was done, then — after the host-taught marker line — how
 * it was checked. A reader leads with the first; the second is evidence.
 */
export function splitSummary(summary: string): { lead: string; checks: string | null } {
  const lines = summary.split(/\r?\n/);
  const at = lines.findIndex(line => line.trim() === GROUND_TRUTH_MARKER);
  if (at < 0) return { lead: summary.trim(), checks: null };
  const checks = lines.slice(at + 1).filter(line => line.trim() !== GROUND_TRUTH_MARKER).join('\n').trim();
  return { lead: lines.slice(0, at).join('\n').trim(), checks: checks || null };
}

export interface ReadableBlock { readonly kind: 'heading' | 'text'; readonly text: string }

const inlineMarkdown = (text: string) =>
  text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`\n]+)`/g, '$1');

/**
 * Markdown an answer was written in, as blocks the canvas can draw: headings
 * become headings, emphasis and inline code marks go, list items take a
 * bullet, table rows read as cells, and fenced code stays verbatim. The
 * canvas draws text, never HTML, so this changes how it reads, not what runs.
 */
export function readableBlocks(source: string): ReadableBlock[] {
  const blocks: ReadableBlock[] = [];
  let paragraph: string[] = [];
  let fenced = false;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'text', text: paragraph.join('\n') });
    paragraph = [];
  };
  for (const raw of source.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { flush(); fenced = !fenced; continue; }
    if (fenced) { paragraph.push(raw); continue; }
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { flush(); blocks.push({ kind: 'heading', text: inlineMarkdown(heading[1]!) }); continue; }
    // A table's separator row, or a horizontal rule: structure, not content.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      paragraph.push(line.trim().slice(1, -1).split('|').map(cell => inlineMarkdown(cell.trim())).join('  ·  '));
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    paragraph.push(bullet ? `${bullet[1]}• ${inlineMarkdown(bullet[2]!)}` : inlineMarkdown(line));
  }
  flush();
  return blocks;
}

/** Pin file links to THIS delivery, never to the repository's moving main. */
export function resultFileUrl(run: VizProjectRun, path: string): string | null {
  const publication = run.publication;
  if (publication?.status !== 'published' || !publication.repositoryUrl ||
      !publication.commitSha || !/^[a-f0-9]{40}$/i.test(publication.commitSha)) return null;
  try {
    const url = new URL(publication.repositoryUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password ||
        !/^\/[\w.-]+\/[\w.-]+\/?$/.test(url.pathname)) return null;
    if (path.split('/').some(part => !part || part === '..' || part === '.') || path.includes('\\')) return null;
    return `${url.origin}${url.pathname.replace(/\/$/, '')}/blob/${publication.commitSha}/${path.split('/').map(encodeURIComponent).join('/')}`;
  } catch { return null; }
}

export function latestDeliveredResult(runs: readonly VizProjectRun[]): VizProjectRun | undefined {
  return runs.filter(run => run.status === 'delivered' && !run.rerunOf && run.traceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
