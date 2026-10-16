// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAtomaMarkFrame } from '../src/viz/client-gl/brand-mark.js';
import {
  ACTIVITY_CRYSTAL_SPEED,
  LOADING_CRYSTAL_COLOR,
  activityCrystalFrame,
} from '../src/viz/client-gl/activity-crystal.js';
import { AtomaLoader } from '../src/viz/client-gl/AtomaLoader.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import { viewLoadingKey } from '../src/viz/client-gl/renderer/loading-notice.js';
import en from '../src/viz/client/locales/en.json' with { type: 'json' };

/**
 * One loading notice for the whole client: the brand crystal turning five
 * times faster than the mark, without its bead, beside "Loading <what>". The
 * canvas and the DOM draw the same frame.
 */

afterEach(() => { cleanup(); setReducedMotionOverrideForTests(null); });

describe('the activity crystal frame', () => {
  it('turns the brand pose five times faster', () => {
    const frame = activityCrystalFrame(1_234, LOADING_CRYSTAL_COLOR, false);
    const mark = buildAtomaMarkFrame(1_234 * ACTIVITY_CRYSTAL_SPEED);
    expect(ACTIVITY_CRYSTAL_SPEED).toBeGreaterThan(1);
    expect(frame.facets).toHaveLength(mark.frontOrder.length);
    expect(frame.facets.every(facet => facet.points.length >= 6)).toBe(true);
  });

  it('holds the rest pose under reduced motion', () => {
    const early = activityCrystalFrame(10, LOADING_CRYSTAL_COLOR, true);
    const late = activityCrystalFrame(9_999, LOADING_CRYSTAL_COLOR, true);
    expect(late).toEqual(early);
  });
});

describe('AtomaLoader', () => {
  it('says what is loading, as a status, beside a crystal with no bead', () => {
    setReducedMotionOverrideForTests(true);
    render(createElement(AtomaLoader, { label: 'Loading conversation…' }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading conversation…');
    const svg = status.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg.querySelector('circle')).toBeNull();
    const drawn = [...svg.querySelectorAll('polygon')].filter(polygon => polygon.getAttribute('points'));
    expect(drawn.length).toBe(activityCrystalFrame(0, LOADING_CRYSTAL_COLOR, true).facets.length);
    expect(document.querySelectorAll('canvas')).toHaveLength(0);
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
