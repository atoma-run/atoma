import { parseMarkdownDetail, type StructuredDetailNode } from './structured-detail.js';

/** Project the recorded inject, never the current catalog's potentially newer recipe. */
export function skillContextDetail(
  event: { preview?: string; chars?: number },
  t: (key: string, vars?: Record<string, unknown>) => string
): { nodes: readonly StructuredDetailNode[]; raw: string; truncated: boolean } {
  const raw = event.preview ?? '';
  const truncated = typeof event.chars === 'number' && event.chars > raw.length;
  let body = raw.replace(/\r\n/g, '\n');
  const header = /^== ACTIVE SKILL: [^\n]+ ==\n/.exec(body);
  if (header) {
    body = body.slice(header[0].length).replace(/\n== END ACTIVE SKILL ==\s*$/, '').trim();
    if (header[0].includes('(kind: script,')) {
      const marker = '\n== SCRIPT BODY ==\n';
      const start = body.indexOf(marker);
      // Script bytes are code, never reflowed as prose.
      return {
        raw, truncated,
        nodes: start < 0 ? [] : [{
          kind: 'field', key: 'code', label: t('detail.field.code'),
          value: body.slice(start + marker.length), tone: 'neutral', presentation: 'code',
        }],
      };
    }
    // The runtime's preamble is paragraph-delimited. Only recognised leading
    // paragraphs move to the raw view; unfamiliar prose remains visible.
    const paragraphs = body.split(/\n\s*\n/);
    if (paragraphs[0]?.startsWith('TRUST BOUNDARY:')) paragraphs.shift();
    if (paragraphs[0]?.startsWith('Follow this recipe step-by-step for the current subtask.')) paragraphs.shift();
    body = paragraphs.join('\n\n');
  }
  return { raw, truncated, nodes: body.trim() ? parseMarkdownDetail(body, t) : [] };
}
