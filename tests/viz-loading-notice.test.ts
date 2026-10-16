// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOADING_CRYSTAL_SPRITE,
  LOADING_ENTER_MS,
  LOADING_LEAVE_MS,
  loadingCrystalFrame,
  loadingLeaveStyle,
} from '../src/viz/client-gl/loading-crystal.js';
import { AtomaLoader, revealClass, useLoadingReveal, type LoadingPhase } from '../src/viz/client-gl/AtomaLoader.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import { viewLoadingKey } from '../src/viz/client-gl/renderer/loading-notice.js';
import en from '../src/viz/client/locales/en.json' with { type: 'json' };

/**
 * One loading notice for the whole client: the original crystal, rendered by
 * the mark itself into a sheet and turning five times faster than the mark,
 * without its bead, beside "Loading <what>". When the content arrives the
 * notice whitens and fades out, then the content fades in.
 */

afterEach(() => { cleanup(); setReducedMotionOverrideForTests(null); vi.useRealTimers(); });

describe('the loading crystal sheet', () => {
  it('plays one full turn at five times the mark rate, and rests under reduced motion', () => {
    const { frames, turnMs } = LOADING_CRYSTAL_SPRITE;
    expect(turnMs).toBe(15_000 / 5);
    expect(loadingCrystalFrame(0, false)).toBe(0);
    expect(loadingCrystalFrame(turnMs / 2, false)).toBe(frames / 2);
    expect(loadingCrystalFrame(turnMs, false)).toBe(0);
    expect(loadingCrystalFrame(1_234, true)).toBe(0);
  });

  it('whitens before it fades, and is gone at the end of the leave', () => {
    expect(loadingLeaveStyle(0)).toEqual({ white: 0, opacity: 1 });
    const middle = loadingLeaveStyle(0.5);
    expect(middle.white).toBeGreaterThan(1 - middle.opacity);
    expect(loadingLeaveStyle(1)).toEqual({ white: 1, opacity: 0 });
  });
});

describe('AtomaLoader', () => {
  it('says what is loading, as a status, beside the sheet crystal', () => {
    render(createElement(AtomaLoader, { label: 'Loading conversation…', section: true }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading conversation…');
    const crystal = status.querySelector('.gpu-loader-crystal') as HTMLElement;
    expect(crystal).toHaveAttribute('aria-hidden', 'true');
    expect(crystal.style.getPropertyValue('--gpu-loader-sheet')).toContain(LOADING_CRYSTAL_SPRITE.url);
    expect(crystal.style.getPropertyValue('--gpu-loader-size')).toBe('46px');
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
  });
});

describe('useLoadingReveal', () => {
  function Probe({ loading, onPhase }: { loading: boolean; onPhase: (phase: LoadingPhase) => void }) {
    onPhase(useLoadingReveal(loading));
    return null;
  }

  it('leaves, then enters, then shows — and keeps the content invisible behind the notice', () => {
    vi.useFakeTimers();
    setReducedMotionOverrideForTests(false);
    const phases: LoadingPhase[] = [];
    const view = render(createElement(Probe, { loading: true, onPhase: phase => phases.push(phase) }));
    view.rerender(createElement(Probe, { loading: false, onPhase: phase => phases.push(phase) }));
    expect(phases.at(-1)).toBe('leaving');
    expect(revealClass('leaving')).toContain('gpu-loading-wait');
    act(() => { vi.advanceTimersByTime(LOADING_LEAVE_MS); });
    expect(phases.at(-1)).toBe('entering');
    expect(revealClass('entering')).toContain('gpu-loading-enter');
    act(() => { vi.advanceTimersByTime(LOADING_ENTER_MS); });
    expect(phases.at(-1)).toBe('shown');
  });

  it('shows content present from the start, and skips the exit under reduced motion', () => {
    const shown: LoadingPhase[] = [];
    render(createElement(Probe, { loading: false, onPhase: phase => shown.push(phase) }));
    expect(new Set(shown)).toEqual(new Set(['shown']));
    setReducedMotionOverrideForTests(true);
    const reduced: LoadingPhase[] = [];
    const view = render(createElement(Probe, { loading: true, onPhase: phase => reduced.push(phase) }));
    view.rerender(createElement(Probe, { loading: false, onPhase: phase => reduced.push(phase) }));
    expect(reduced.at(-1)).toBe('shown');
    expect(reduced).not.toContain('leaving');
  });
});

describe('viewLoadingKey', () => {
  const catalog = en as Record<string, string>;
  it('names what every loading view waits on, in the catalog', () => {
    const views = ['projects', 'runs', 'registry', 'skills', 'burnin', 'admin', 'journal', 'ledger',
      'sentinel', 'liveRuns', 'settings'];
    for (const view of views) {
      const key = viewLoadingKey(view);
      expect(key, view).not.toBe('common.loading');
      expect(catalog[key], key).toMatch(/^Loading /);
    }
    expect(catalog[viewLoadingKey('projects', { project: true })]).toBe('Loading this project…');
    expect(catalog[viewLoadingKey('runs', { run: true })]).toBe('Loading this run…');
  });
});
