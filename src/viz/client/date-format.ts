/**
 * ONE formatter per locale and option set, built once and reused.
 *
 * `Date#toLocaleString` and its `toLocaleDateString`/`toLocaleTimeString`
 * shorthands construct a fresh `Intl.DateTimeFormat` on EVERY call: ~0.07ms
 * each in Chrome, against ~0.0014ms for `format()` on a cached instance
 * (measured 2026-09-30, Chrome 151 on a Ryzen 5 5500U). The GPU client
 * formats a clock per timeline card on every scene rebuild, and a live run
 * rebuilds once a second, so that construction was a fifth of each Runs
 * rebuild. An empty locale list and `undefined` both mean the runtime
 * default and share one entry.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormat(
  locale: string | readonly string[] | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const locales = typeof locale === 'string' ? [locale] : [...(locale ?? [])];
  const key = `${locales.join(',')}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locales, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

const CLOCK_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * The time of day with seconds, in the runtime default locale: the clock a
 * timeline card and a run's bookends carry, where sub-minute order matters.
 * Empty for an instant that will not parse, so a card keeps its other facts.
 */
export function clockTime(ms: number): string {
  return Number.isFinite(ms) ? dateTimeFormat(undefined, CLOCK_OPTIONS).format(ms) : '';
}

/**
 * Human-readable metadata timestamps. Operational clocks and exact diagnostic
 * tooltips keep their seconds; catalogue metadata normally does not need them.
 * Invalid values remain visible verbatim instead of becoming "Invalid Date".
 */
export function formatDateTime(
  at: string | number,
  locale: string,
  options: { seconds?: boolean; dateStyle?: 'long' | 'full' } = {}
): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at);
  return dateTimeFormat(locale, {
    dateStyle: options.dateStyle ?? 'long',
    timeStyle: options.seconds ? 'medium' : 'short',
  }).format(date);
}

/**
 * A calendar date alone, for facts where the hour carries nothing: the day a
 * member joined, the day a key was configured. Same tolerance for bad input.
 */
export function formatDate(at: string | number, locale: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return String(at);
  return dateTimeFormat(locale, { dateStyle: 'long' }).format(date);
}
