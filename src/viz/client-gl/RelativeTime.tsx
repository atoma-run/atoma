import { useCallback, useSyncExternalStore } from 'react';
import { relativeTime, timestampTooltip } from './renderer/relative-time.js';
import { subscribeRelativeTime } from './relative-time-clock.js';

/** A timestamp that ages on its own, keeping the exact instant on hover. */
export function RelativeTime({ at, locale, t }: {
  at: string;
  locale: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const read = useCallback(() => relativeTime(at, t, locale) || at, [at, t, locale]);
  const label = useSyncExternalStore(subscribeRelativeTime, read, read);
  return <time dateTime={at} title={timestampTooltip(at, locale) ?? at}>{label}</time>;
}
