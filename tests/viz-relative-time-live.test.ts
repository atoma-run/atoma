// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelativeTime } from '../src/viz/client-gl/RelativeTime.js';
import { RelativeTimeView } from '../src/viz/client-gl/relative-time-clock.js';
import { translate } from '../src/viz/client/i18n-catalog.js';

const en = (key: string, vars?: Record<string, unknown>) => translate('en', key, vars);
const now = new Date(2026, 9, 20, 12).getTime();
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('live relative timestamps', () => {
  it('ages mounted components with one clock, retaining the exact timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const at = new Date(now).toISOString();
    const view = render(createElement(Fragment, null, createElement(RelativeTime, { at, locale: 'en', t: en }), createElement(RelativeTime, { at, locale: 'en', t: en })));
    expect(screen.getAllByText('a few seconds ago')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(1);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(screen.getAllByText('a minute ago')).toHaveLength(2);
    await act(() => vi.advanceTimersByTime(45_000));
    expect(screen.getAllByText('a few minutes ago')).toHaveLength(2);
    expect(view.container.querySelector('time')?.dateTime).toBe(at);
    expect(view.container.querySelector('time')?.title).toContain('2026');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes canvas layout only when its displayed wording changes, including on return', () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const at = now;
    let label = '';
    const draw = vi.fn(() => {
      view.clear();
      label = view.format(at, en, 'en');
    });
    const view = new RelativeTimeView(draw);
    draw();
    view.start();
    try {
      vi.advanceTimersByTime(44_000);
      expect(draw).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1000);
      expect(label).toBe('a minute ago');
      expect(draw).toHaveBeenCalledTimes(2);
      view.stop();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60 * 60_000);
      expect(draw).toHaveBeenCalledTimes(2);
      view.start();
      expect(label).toBe('an hour ago');
      expect(draw).toHaveBeenCalledTimes(3);
      view.clear();
      vi.advanceTimersByTime(24 * 60 * 60_000);
      expect(draw).toHaveBeenCalledTimes(3);
    } finally { view.stop(); }
  });

  it('pauses the shared clock while hidden and catches up when visible', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    render(createElement(RelativeTime, { at: new Date(now).toISOString(), locale: 'en', t: en }));
    hidden = true;
    await act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTime(2 * 60_000));
    expect(screen.getByText('a few seconds ago')).toBeTruthy();
    hidden = false;
    await act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByText('a few minutes ago')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(1);
  });
});
