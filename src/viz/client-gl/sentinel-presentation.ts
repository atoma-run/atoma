import type { VizSentinelSnapshot, VizSentinelWatchHealth } from '../client/types.js';
import { formatDateTime } from '../client/date-format.js';
import { SENTINEL_SECTIONS, type SentinelSection } from './store.js';
import type { AssayerViewData } from './assayer-presentation.js';
import type { ButtonIconKind } from './button-icons.js';

/**
 * THE SENTINEL SCREEN'S FACTS, renderer-free, so the canvas and its
 * accessible DOM twin say exactly the same thing in the same words. One tab
 * strip, one headline per tab, one row of figures per tab — and the sentences
 * the screen is obliged to carry in every state (its scope; that a finding is
 * a flag, never a judgment).
 */

type Translate = (key: string, vars?: Record<string, unknown>) => string;

export const SENTINEL_SECTION_ICONS: Record<SentinelSection, ButtonIconKind> = {
  watch: 'clock',
  assayer: 'check',
  coverage: 'play',
  rules: 'checklist',
  findings: 'flag',
};

export interface SentinelTab {
  readonly id: SentinelSection;
  /** The tab's name alone, for an accessible label. */
  readonly name: string;
  /** The name with its count, as drawn: "Findings · 3". */
  readonly label: string;
  readonly count: number | null;
}

/** Tabs in reading order, each carrying the count its content lists. */
export function sentinelTabs(
  payload: VizSentinelSnapshot | null,
  assayer: AssayerViewData | null | undefined,
  t: Translate
): SentinelTab[] {
  const counts: Record<SentinelSection, number | null> = {
    watch: null,
    assayer: assayer ? assayer.assays.length : null,
    coverage: payload ? payload.live.length : null,
    rules: payload ? payload.rules.length : null,
    findings: payload ? payload.findings.length : null,
  };
  return SENTINEL_SECTIONS.map(id => {
    const name = t(`sentinel.section.${id}`);
    const count = counts[id];
    // The assayer pages: a loaded count with more behind it reads "12+".
    const shown = count === null ? null : id === 'assayer' && assayer?.hasMore ? `${count}+` : String(count);
    return { id, name, count, label: shown === null ? name : `${name} · ${shown}` };
  });
}

export type SentinelTone = 'ok' | 'off' | 'warning' | 'bad' | 'muted';

export interface SentinelStat {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** One state word for the watch, and the sentence that backs it. */
export function sentinelWatchStatus(
  watch: VizSentinelWatchHealth | null,
  t: Translate,
  locale: string
): { headline: string; tone: SentinelTone; sentence: string } {
  const stamp = (at: string) => formatDateTime(at, locale, { seconds: true });
  if (!watch) return { headline: t('sentinel.watch.state.unknown'), tone: 'muted', sentence: t('sentinel.watch.never') };
  if (watch.armed) {
    return {
      headline: t('sentinel.watch.state.watching'),
      tone: 'ok',
      sentence: t('sentinel.watch.armed', { count: Math.round(watch.intervalMs / 1000), since: stamp(watch.armedSince ?? watch.startedAt) }),
    };
  }
  if (watch.reason === 'disabled') return { headline: t('sentinel.watch.state.off'), tone: 'off', sentence: t('sentinel.watch.disabled') };
  if (watch.reason === 'lease-held' && watch.incumbent) {
    return {
      headline: t('sentinel.watch.state.yielded'),
      tone: 'muted',
      sentence: t('sentinel.watch.leaseHeld', {
        source: watch.incumbent.source, pid: watch.incumbent.ownerPid,
        since: stamp(watch.incumbent.startedAt), beat: stamp(watch.incumbent.heartbeatAt),
      }),
    };
  }
  if (watch.reason === 'lease-lost') return { headline: t('sentinel.watch.state.yielded'), tone: 'muted', sentence: t('sentinel.watch.leaseLost') };
  if (watch.reason === 'failing') {
    return {
      headline: t('sentinel.watch.state.stopped'),
      tone: 'warning',
      sentence: t('sentinel.watch.failing', { count: watch.consecutiveFailures, error: (watch.lastError ?? '').slice(0, 120) }),
    };
  }
  return { headline: t('sentinel.watch.state.off'), tone: 'off', sentence: t('sentinel.watch.off', { reason: watch.reason }) };
}

/** The watch's own counters as label/value pairs: one tile each. */
export function sentinelWatchStats(watch: VizSentinelWatchHealth | null, t: Translate, locale: string): SentinelStat[] {
  if (!watch) return [];
  const n = (value: number) => value.toLocaleString(locale);
  return [
    { key: 'passes', label: t('sentinel.stat.passes'), value: n(watch.ticks) },
    { key: 'lastPass', label: t('sentinel.stat.lastPass'), value: watch.lastTickAt === null ? '—' : t('sentinel.stat.ms', { count: watch.lastTickMs ?? 0 }) },
    { key: 'screened', label: t('sentinel.stat.screened'), value: n(watch.runsScreenedLastTick) },
    { key: 'skipped', label: t('sentinel.stat.skipped'), value: n(watch.skippedLastTick) },
    { key: 'written', label: t('sentinel.stat.written'), value: n(watch.emittedSinceBoot) },
  ];
}

/** The sentences under the tiles, in order; the scope sentence is never optional. */
export function sentinelWatchNotes(watch: VizSentinelWatchHealth | null, t: Translate, locale: string): string[] {
  const notes: string[] = [];
  if (watch) {
    notes.push(watch.lastTickAt === null
      ? t('sentinel.watch.never')
      : t('sentinel.watch.lastPassAt', { at: formatDateTime(watch.lastTickAt, locale, { seconds: true }) }));
    // One pass that took a quarter of a second is worth an operator's
    // attention: the tick is synchronous and shares the HTTP loop.
    if ((watch.lastTickMs ?? 0) > 250) notes.push(t('sentinel.watch.slow', { ms: watch.lastTickMs ?? 0 }));
  }
  notes.push(t('sentinel.watch.scope'), t('sentinel.watch.headless'));
  return notes;
}

/** The assayer's state word, and the facts beside it. */
export function assayerStatus(data: AssayerViewData | null | undefined, t: Translate, locale: string): { headline: string; tone: SentinelTone; facts: string[] } {
  const h = data?.health ?? null;
  if (!h) return { headline: t('assayer.unavailable'), tone: 'muted', facts: [] };
  const facts: string[] = [];
  if (h.executorRelease) facts.push(t('assayer.executor', { release: h.executorRelease.slice(0, 12) }));
  facts.push(t(h.inFlight ? 'assayer.running' : 'assayer.idle', { skill: h.inFlight ?? '' }));
  if (h.pausedUntil) facts.push(t('assayer.paused', { at: formatDateTime(h.pausedUntil, locale) }));
  if (h.lastError) facts.push(h.lastError);
  return {
    headline: t(h.armed ? 'assayer.armed' : 'assayer.off'),
    tone: h.armed ? (h.pausedUntil ? 'warning' : 'ok') : 'off',
    facts,
  };
}

export function assayerStats(data: AssayerViewData | null | undefined, t: Translate, locale: string): SentinelStat[] {
  const h = data?.health ?? null;
  if (!h) return [];
  const n = (value: number) => value.toLocaleString(locale);
  return [
    { key: 'completed', label: t('assayer.stat.completed'), value: n(h.assayed) },
    { key: 'failed', label: t('assayer.stat.failed'), value: n(h.failed) },
    { key: 'deferred', label: t('assayer.stat.deferred'), value: n(h.deferred) },
    { key: 'preempted', label: t('assayer.stat.preempted'), value: n(h.preempted) },
  ];
}

/** The tone of one evaluation row's verdict column. */
export function assayVerdictTone(row: AssayerViewData['assays'][number]): SentinelTone {
  if (row.status !== 'completed' || !row.judgement) return 'muted';
  switch (row.judgement.verdict) {
    case 'helpful': return 'ok';
    case 'harmful': return 'bad';
    default: return 'muted';
  }
}
