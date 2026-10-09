import type { RunIndexEntry } from '../client/types.js';
import { isIndexEntryLive, runCost } from '../client/run-utils.js';
import { matchesSearchQuery, runSearchText } from '../client/search.js';
import { fmtTokenCount, type GpuTranslate } from './renderer/copy.js';

export const RUN_PICKER_ROW_HEIGHT = 49;
export const RUN_PICKER_GROUP_HEIGHT = 46;
export const RUN_PICKER_HEADER_HEIGHT = 30;

function runProjectKey(run: RunIndexEntry): string {
  return run.projectId ? `id:${run.projectId}`
    : run.projectSlug ? `slug:${run.projectSlug}` : 'unassigned';
}

/** Follow the displayed run's breadcrumb, not a project left in another view. */
export function runsInPickerScope(
  runs: readonly RunIndexEntry[],
  selectedRunId: string | null,
  selectedProjectId: string | null
): readonly RunIndexEntry[] {
  const selected = runs.find(run => run.id === selectedRunId);
  const key = selected ? runProjectKey(selected)
    : selectedProjectId ? `id:${selectedProjectId}` : 'unassigned';
  return key === 'unassigned' ? runs : runs.filter(run => runProjectKey(run) === key);
}

/** Shared by the GPU popup and native input's keyboard navigation. */
export function runPickerViewportHeight(height: number, popupY: number): number {
  return Math.max(RUN_PICKER_ROW_HEIGHT, Math.min(500, height - popupY - 10) - RUN_PICKER_HEADER_HEIGHT - 7);
}

/** Project activity orders groups; search only removes non-matching runs. */
export function buildRunPicker(runs: readonly RunIndexEntry[], query = '', now = Date.now()) {
  const byProject = new Map<string, RunIndexEntry[]>();
  for (const run of runs) {
    const key = runProjectKey(run);
    const group = byProject.get(key) ?? [];
    group.push(run);
    byProject.set(key, group);
  }
  const started = (run: RunIndexEntry) => Date.parse(run.startedAt) || 0;
  const groups = [...byProject.entries()].map(([key, entries]) => ({
    key,
    label: entries.find(run => run.projectName)?.projectName
      ?? entries.find(run => run.projectSlug)?.projectSlug
      ?? entries.find(run => run.projectId)?.projectId,
    live: entries.some(run => isIndexEntryLive(run, now)),
    latest: Math.max(...entries.map(started)),
    // Project spend includes every run, even when search hides some rows.
    totals: {
      tokens: sumRecorded(entries, 'tokens'),
      costUsd: sumRecorded(entries, 'costUsd'),
      complete: entries.every(run => run.tokens !== undefined && run.costUsd !== undefined),
    },
    runs: entries.sort((a, b) => Number(isIndexEntryLive(b, now)) - Number(isIndexEntryLive(a, now))
      || started(b) - started(a)).filter(run => matchesSearchQuery(runSearchText(run), query)),
  })).filter(group => group.runs.length > 0)
    .sort((a, b) => Number(b.live) - Number(a.live) || b.latest - a.latest);

  let top = 0;
  const options: { run: RunIndexEntry; top: number }[] = [];
  const sections = groups.map(group => {
    const headerTop = top;
    top += RUN_PICKER_GROUP_HEIGHT;
    const rows = group.runs.map(run => {
      const row = { run, top, index: options.length };
      options.push(row);
      top += RUN_PICKER_ROW_HEIGHT;
      return row;
    });
    return { key: group.key, label: group.label, totals: group.totals, top: headerTop, rows };
  });
  return { sections, options, height: top };
}

function sumRecorded(runs: readonly RunIndexEntry[], field: 'tokens' | 'costUsd'): number | undefined {
  const values = runs.flatMap(run => run[field] === undefined ? [] : [run[field]]);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

/** The canvas and its accessible project groups announce the same spend. */
export function runPickerTotalsLabel(
  totals: ReturnType<typeof buildRunPicker>['sections'][number]['totals'],
  t: GpuTranslate
): string {
  return t(totals.complete ? 'runs.picker.projectTotals' : 'runs.picker.projectRecorded', {
    tokens: totals.tokens === undefined ? '—' : fmtTokenCount(totals.tokens),
    cost: runCost(totals.costUsd),
  });
}
