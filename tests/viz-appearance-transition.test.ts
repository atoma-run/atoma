// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_FROM_WHITE_MS,
  APPEARANCE_TO_WHITE_MS,
  AppearanceVeilLayer,
  appearanceTransitionSample,
  useAppearanceTransition,
} from '../src/viz/client-gl/appearance-transition.js';
import { markCoreSurge, setMarkCoreSurge } from '../src/viz/client-gl/renderer/mark-surge.js';
import { setMarkSpinBoost } from '../src/viz/client-gl/renderer/mark-clock.js';
import { setReducedMotionOverrideForTests } from '../src/viz/client-gl/renderer/motion.js';
import { useGpuStore } from '../src/viz/client-gl/store.js';

function Probe() {
  const transition = useAppearanceTransition();
  return createElement(AppearanceVeilLayer, transition);
}

describe('appearance transition', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotionOverrideForTests(false);
    frames = new Map();
    nextFrameId = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    localStorage.clear();
    useGpuStore.setState({
      entered: true,
      appearanceTheme: 'nocturne',
      appearanceTransitionTarget: null,
      themeDropdownOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    setReducedMotionOverrideForTests(null);
    setMarkCoreSurge(0);
    setMarkSpinBoost(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function frame(now: number) {
    const callback = frames.values().next().value;
    expect(callback).toBeDefined();
    frames.clear();
    act(() => callback!(now));
  }

  it('charges the crystal, fills the screen, then reveals the committed theme', () => {
    const { container } = render(createElement(Probe));
    act(() => useGpuStore.getState().setAppearanceTheme('amethyst'));
    expect(useGpuStore.getState().appearanceTheme).toBe('nocturne');
    expect(localStorage.getItem('atoma.viz.theme')).toBeNull();
    expect(container.querySelector('.gpu-appearance-veil')).toHaveAttribute('data-phase', 'charge');

    frame(0);
    frame(APPEARANCE_TO_WHITE_MS / 2);
    expect(markCoreSurge()).toBeGreaterThan(0.5);
    expect(useGpuStore.getState().appearanceTheme).toBe('nocturne');
    frame(APPEARANCE_TO_WHITE_MS);
    expect(container.querySelector('.gpu-appearance-veil__white')).toHaveStyle({ opacity: '1' });
    expect(container.querySelector('.gpu-appearance-veil')).toHaveAttribute('data-phase', 'reveal');
    expect(useGpuStore.getState().appearanceTheme).toBe('amethyst');
    expect(localStorage.getItem('atoma.viz.theme')).toBe('amethyst');
    expect(markCoreSurge()).toBe(0);

    act(() => { vi.advanceTimersByTime(APPEARANCE_FROM_WHITE_MS); });
    expect(container.querySelector('.gpu-appearance-veil')).toBeNull();
    expect(useGpuStore.getState().appearanceTransitionTarget).toBeNull();
  });

  it('jumps directly to the selected theme under reduced motion', () => {
    setReducedMotionOverrideForTests(true);
    useGpuStore.getState().setAppearanceTheme('copper');
    expect(useGpuStore.getState().appearanceTheme).toBe('copper');
    expect(useGpuStore.getState().appearanceTransitionTarget).toBeNull();
    expect(localStorage.getItem('atoma.viz.theme')).toBe('copper');
  });

  it('lets the crystal lead and reaches a solid white final frame', () => {
    expect(appearanceTransitionSample(0)).toMatchObject({ surge: 0, flood: 0, whiteAlpha: 0 });
    const middle = appearanceTransitionSample(0.5);
    expect(middle.surge).toBeGreaterThan(middle.flood);
    expect(middle.spin).toBeCloseTo(1);
    expect(appearanceTransitionSample(1)).toMatchObject({ flood: 1, whiteAlpha: 1 });
    expect(appearanceTransitionSample(1).spin).toBeCloseTo(0);
  });
});
