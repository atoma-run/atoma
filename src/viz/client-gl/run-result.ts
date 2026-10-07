import type { VizProjectRun, VizRun } from '../client/types.js';

/** Only the persisted final output is a delivery; intermediate events are not. */
export function resultText(run: VizRun | null): string | null {
  const output = run?.result?.output;
  if (output === undefined || output === null) return null;
  if (typeof output === 'string') return output;
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
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return Object.entries(output).flatMap(([title, value]) =>
      typeof value === 'string' && value.trim() ? [{ title, text: value }] : []);
  }
  return [];
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
