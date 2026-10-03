import path from 'node:path';
import type { ProjectRun } from '../contracts/projects.js';
import { resolveProjectRunTraceFile, type ProjectStore } from '../projects/store.js';
import { readBoundedRunFile } from './runIndex.js';

/**
 * THE PUBLIC SHOWCASE: the platform admin's delivered runs, readable by anyone.
 * ============================================================================
 *
 * Exposure is the whole risk here, so the contract is narrow and written once:
 *
 * - OFF UNLESS THE HOST SAYS SO (`ATOMA_PUBLIC_SHOWCASE=1`). Publishing a
 *   person's work is an operator decision, never a side effect of a deploy.
 * - THE SET is `ProjectStore.listShowcaseRuns`: delivered, not a rerun, and
 *   requested by a PLATFORM ADMIN. Nothing here widens it.
 * - THE PROJECTION is an allow-list. A visitor sees a title, the request, the
 *   outcome's numbers, deliverable file NAMES and sizes, and the answer of a
 *   text delivery. Never an organisation, project or principal identity, a
 *   host path, a repository, a publication receipt, a trace, or file bytes.
 * - ALL OF IT IS DATA. The goal and the answer are tenant-authored and
 *   model-authored text; `showcasePage.ts` escapes every value and this module
 *   bounds every length.
 */

export const SHOWCASE_ENV = 'ATOMA_PUBLIC_SHOWCASE';
export const showcaseEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env[SHOWCASE_ENV] === '1';

/**
 * Does THIS request get the showcase as its home page? Only a bare `/` from a
 * visitor with no session, while it is published. A query string always means
 * the app shell: `?authNotice=`, `?invite=` and the rehearsal flags are read
 * by it, and an arrival bounced back from a failed login must still see why.
 */
export function servesShowcaseHome(input: {
  readonly enabled: boolean;
  readonly pathname: string;
  readonly search: string;
  readonly hasSession: boolean;
}): boolean {
  return input.enabled && input.pathname === '/' && input.search === '' && !input.hasSession;
}

export const SHOWCASE_TITLE_MAX = 80;
export const SHOWCASE_ANSWER_MAX = 8_000;
export const SHOWCASE_FILES_MAX = 12;
/** How long a built showcase is reused: the page is public, the store is not a CDN. */
export const SHOWCASE_TTL_MS = 60_000;

/** What a visitor filters by; derived from the deliverable, never from prose. */
export type ShowcaseKind = 'answers' | 'reports' | 'media' | 'software';

export const SHOWCASE_KINDS: readonly ShowcaseKind[] = ['answers', 'reports', 'media', 'software'];

export interface ShowcaseFile {
  readonly path: string;
  readonly size: number;
}

export interface ShowcaseEpisode {
  /** The run's id: unguessable, and listed only because the run is public. */
  readonly id: string;
  readonly title: string;
  /** The request in full (bounded by the goal schema at 4 000 characters). */
  readonly request: string;
  readonly endedAt: string | null;
  readonly durationS: number | null;
  readonly costUsd: number | null;
  /** Times the final review sent the work back before it was accepted. */
  readonly sentBack: number;
  readonly files: readonly ShowcaseFile[];
  readonly textDelivery: boolean;
}

export interface ShowcaseEntry {
  /** The earliest public run of the project: stable as later ones arrive. */
  readonly id: string;
  readonly kind: ShowcaseKind;
  readonly episodes: readonly ShowcaseEpisode[];
  readonly endedAt: string | null;
  readonly totalDurationS: number | null;
  readonly totalCostUsd: number | null;
}

const MEDIA_EXTENSIONS = new Set([
  '.wav', '.mp3', '.ogg', '.flac', '.mp4', '.webm', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp',
]);
const SOFTWARE_MARKERS = new Set(['index.html', 'server.js', 'package.json', 'app.py', 'main.py']);

/** A deliverable's kind from its file names alone: deterministic, display-only. */
export function classifyShowcase(run: Pick<ProjectRun, 'artifactManifest'>): ShowcaseKind {
  const manifest = run.artifactManifest;
  if (!manifest || manifest.delivery === 'text' || manifest.files.length === 0) return 'answers';
  const names = manifest.files.map((file) => file.path.toLowerCase());
  if (names.some((name) => SOFTWARE_MARKERS.has(path.posix.basename(name)))) return 'software';
  if (names.some((name) => MEDIA_EXTENSIONS.has(path.posix.extname(name)))) return 'media';
  return 'reports';
}

/** The goal cut to one short line, for a run that was never named. */
export function titleFromGoal(goal: string): string {
  const line = goal.replace(/\s+/g, ' ').trim();
  if (line.length <= SHOWCASE_TITLE_MAX) return line;
  const room = line.slice(0, SHOWCASE_TITLE_MAX - 1);
  const cut = room.lastIndexOf(' ');
  return `${(cut > SHOWCASE_TITLE_MAX / 2 ? room.slice(0, cut) : room).trimEnd()}…`;
}

function episodeOf(run: ProjectRun): ShowcaseEpisode {
  const elapsedMs = run.startedAt && run.endedAt ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : NaN;
  const files = (run.artifactManifest?.files ?? [])
    .filter((file) => !path.posix.basename(file.path).startsWith('.'))
    .slice(0, SHOWCASE_FILES_MAX)
    .map((file) => ({ path: file.path, size: file.size }));
  return {
    id: run.projectRunId,
    title: run.title ?? titleFromGoal(run.goal),
    request: run.goal,
    endedAt: run.endedAt,
    durationS: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs / 1000) : null,
    costUsd: run.stats?.costUsd ?? null,
    sentBack: run.stats?.rootRemediations ?? 0,
    files,
    textDelivery: run.artifactManifest?.delivery === 'text',
  };
}

const sum = (values: readonly (number | null)[]): number | null => {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
};

/** Group public runs by project (an identity that never leaves this function), newest entry first. */
export function buildShowcase(runs: readonly ProjectRun[]): ShowcaseEntry[] {
  const byProject = new Map<string, ProjectRun[]>();
  for (const run of [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const group = byProject.get(run.projectId);
    if (group) group.push(run);
    else byProject.set(run.projectId, [run]);
  }
  const entries: ShowcaseEntry[] = [];
  for (const group of byProject.values()) {
    const episodes = group.map(episodeOf);
    const latest = group[group.length - 1]!;
    entries.push({
      id: group[0]!.projectRunId,
      kind: classifyShowcase(latest),
      episodes,
      endedAt: latest.endedAt,
      totalDurationS: sum(episodes.map((episode) => episode.durationS)),
      totalCostUsd: sum(episodes.map((episode) => episode.costUsd)),
    });
  }
  return entries.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
}

/** The answer a text delivery kept in its trace, bounded; null when there is none to show. */
export function readShowcaseAnswer(run: ProjectRun): string | null {
  if (run.artifactManifest?.delivery !== 'text') return null;
  const file = resolveProjectRunTraceFile({
    projectRunId: run.projectRunId,
    runsPath: run.hostPaths.runsPath,
    traceId: run.traceId,
  });
  if (!file) return null;
  const read = readBoundedRunFile(file);
  if (!read.ok) return null;
  try {
    const trace = JSON.parse(read.bytes.toString('utf8')) as { result?: { output?: unknown } };
    const output = trace.result?.output;
    if (output === undefined || output === null) return null;
    const text = typeof output === 'string' ? output : JSON.stringify(output, null, 2);
    return text.length > SHOWCASE_ANSWER_MAX ? `${text.slice(0, SHOWCASE_ANSWER_MAX)}…` : text;
  } catch {
    return null;
  }
}

export interface ShowcaseSource {
  entries(): ShowcaseEntry[];
  entry(id: string): ShowcaseEntry | null;
  /** The answer of one episode of one entry, or null. */
  answer(entryId: string, episodeId: string): string | null;
}

/** A showcase over the store, rebuilt at most once per TTL. */
export function createShowcaseSource(
  store: Pick<ProjectStore, 'listShowcaseRuns'>,
  now: () => number = Date.now
): ShowcaseSource {
  let built: { at: number; runs: Map<string, ProjectRun>; entries: ShowcaseEntry[] } | null = null;
  const current = () => {
    if (built && now() - built.at < SHOWCASE_TTL_MS) return built;
    const runs = store.listShowcaseRuns();
    built = {
      at: now(),
      runs: new Map(runs.map((run) => [run.projectRunId, run])),
      entries: buildShowcase(runs),
    };
    return built;
  };
  return {
    entries: () => current().entries,
    entry: (id) => current().entries.find((entry) => entry.id === id) ?? null,
    answer(entryId, episodeId) {
      const state = current();
      const entry = state.entries.find((candidate) => candidate.id === entryId);
      if (!entry?.episodes.some((episode) => episode.id === episodeId)) return null;
      const run = state.runs.get(episodeId);
      return run ? readShowcaseAnswer(run) : null;
    },
  };
}
