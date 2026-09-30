import { describe, expect, it } from 'vitest';
import {
  clockTime,
  dateTimeFormat,
  formatDate,
  formatDateTime,
} from '../src/viz/client/date-format.js';

/**
 * The cached formatters must say exactly what the per-call `toLocale*`
 * shorthands said: the cache is a cost change (one `Intl.DateTimeFormat` per
 * locale and option set instead of one per call), never a copy change.
 */
describe('date-format', () => {
  const at = Date.parse('2026-09-30T18:31:15.860Z');

  it('builds one formatter per locale and option set', () => {
    const options = { hour: '2-digit', minute: '2-digit' } as const;
    expect(dateTimeFormat('fr', { ...options })).toBe(dateTimeFormat('fr', { ...options }));
    expect(dateTimeFormat('fr', options)).not.toBe(dateTimeFormat('en', options));
    expect(dateTimeFormat([], options)).toBe(dateTimeFormat(undefined, options));
  });

  it('formats the card clock as toLocaleTimeString did', () => {
    expect(clockTime(at)).toBe(new Date(at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }));
    expect(clockTime(Number.NaN)).toBe('');
  });

  it('keeps product dates identical and bad input verbatim', () => {
    for (const locale of ['en', 'fr', 'zh']) {
      expect(formatDateTime(at, locale)).toBe(
        new Date(at).toLocaleString(locale, { dateStyle: 'long', timeStyle: 'short' })
      );
      expect(formatDateTime(at, locale, { seconds: true, dateStyle: 'full' })).toBe(
        new Date(at).toLocaleString(locale, { dateStyle: 'full', timeStyle: 'medium' })
      );
      expect(formatDate(at, locale)).toBe(new Date(at).toLocaleDateString(locale, { dateStyle: 'long' }));
    }
    expect(formatDateTime('not a date', 'en')).toBe('not a date');
    expect(formatDate('not a date', 'en')).toBe('not a date');
  });
});
