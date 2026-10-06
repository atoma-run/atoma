// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_FROM_WHITE_MS,
  APPEARANCE_TO_WHITE_MS,
  AppearanceVeilLayer,
  appearanceRevealSample,
  appearanceTransitionSample,
  useAppearanceTransition,
} from '../src/viz/client-gl/appearance-transition.js';
import { markCoreSurge, setMarkCoreSurge, writeMarkCoreScreen } from '../src/viz/client-gl/renderer/mark-surge.js';
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
    writeMarkCoreScreen({ clientX: 64, clientY: 40, radiusPx: 8 });
    localStorage.clear();
    useGpuStore.setState({
      entered: true,
      appearanceTheme: 'nocturne',
      appearanceTransitionTarget: null,
      accountMenuOpen: false,
      themeDropdownOpen: false,
    });
  });

  afterEach(() => {
    cleanup();
    setReducedMotionOverrideForTests(null);
    setMarkCoreSurge(0);
    writeMarkCoreScreen(null);
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
    act(() => useGpuStore.setState({ accountMenuOpen: true, themeDropdownOpen: true }));
    act(() => useGpuStore.getState().setAppearanceTheme('amethyst'));
    expect(useGpuStore.getState().accountMenuOpen).toBe(false);
    expect(useGpuStore.getState().themeDropdownOpen).toBe(false);
    expect(useGpuStore.getState().appearanceTheme).toBe('nocturne');
    expect(localStorage.getItem('atoma.viz.theme')).toBeNull();
    expect(container.querySelector('.gpu-appearance-veil')).toHaveAttribute('data-phase', 'charge');

    frame(0);
    expect(container.querySelector<HTMLElement>('.gpu-appearance-veil__white')?.style.getPropertyValue('--appearance-origin-x')).toBe('64px');
    expect(container.querySelector<HTMLElement>('.gpu-appearance-veil__white')?.style.getPropertyValue('--appearance-origin-y')).toBe('40px');
    frame(APPEARANCE_TO_WHITE_MS / 2);
    expect(markCoreSurge()).toBeGreaterThan(0.5);
    expect(useGpuStore.getState().appearanceTheme).toBe('nocturne');
    frame(APPEARANCE_TO_WHITE_MS);
    expect(container.querySelector('.gpu-appearance-veil__white')).toHaveStyle({ opacity: '1' });
    expect(container.querySelector('.gpu-appearance-veil')).toHaveAttribute('data-phase', 'reveal');
    expect(container.querySelector('.gpu-appearance-veil')).toHaveAttribute('data-theme', 'amethyst');
    expect(container.querySelector<HTMLElement>('.gpu-appearance-veil__colour')?.style.getPropertyValue('--appearance-origin-x')).toBe('64px');
    expect(useGpuStore.getState().appearanceTheme).toBe('amethyst');
    expect(localStorage.getItem('atoma.viz.theme')).toBe('amethyst');
    expect(markCoreSurge()).toBe(1);

    frame(APPEARANCE_TO_WHITE_MS + APPEARANCE_FROM_WHITE_MS / 2);
    const white = container.querySelector<HTMLElement>('.gpu-appearance-veil__white');
    const colour = container.querySelector<HTMLElement>('.gpu-appearance-veil__colour');
    expect(Number(white?.style.opacity)).toBeGreaterThan(0);
    expect(Number(white?.style.opacity)).toBeLessThan(1);
    expect(Number(colour?.style.opacity)).toBeGreaterThan(0.9);
    expect(markCoreSurge()).toBeGreaterThan(0);
    expect(markCoreSurge()).toBeLessThan(1);
    expect(useGpuStore.getState().appearanceTransitionTarget).toBe('amethyst');

    frame(APPEARANCE_TO_WHITE_MS + APPEARANCE_FROM_WHITE_MS * 0.8);
    expect(Number(white?.style.opacity)).toBe(0);
    expect(Number(colour?.style.opacity)).toBeGreaterThan(0);
    expect(Number(colour?.style.opacity)).toBeLessThan(1);

    frame(APPEARANCE_TO_WHITE_MS + APPEARANCE_FROM_WHITE_MS);
    expect(container.querySelector('.gpu-appearance-veil')).toBeNull();
    expect(useGpuStore.getState().appearanceTransitionTarget).toBeNull();
    expect(markCoreSurge()).toBe(0);
  });

  it('jumps directly to the selected theme under reduced motion', () => {
    setReducedMotionOverrideForTests(true);
    useGpuStore.setState({ accountMenuOpen: true, themeDropdownOpen: true });
    useGpuStore.getState().setAppearanceTheme('copper');
    expect(useGpuStore.getState().accountMenuOpen).toBe(false);
    expect(useGpuStore.getState().themeDropdownOpen).toBe(false);
    expect(useGpuStore.getState().appearanceTheme).toBe('copper');
    expect(useGpuStore.getState().appearanceTransitionTarget).toBeNull();
    expect(localStorage.getItem('atoma.viz.theme')).toBe('copper');
  });

  it('dismisses the entire menu when the active theme is selected again', () => {
    useGpuStore.setState({ accountMenuOpen: true, themeDropdownOpen: true });
    useGpuStore.getState().setAppearanceTheme('nocturne');
    expect(useGpuStore.getState().accountMenuOpen).toBe(false);
    expect(useGpuStore.getState().themeDropdownOpen).toBe(false);
    expect(useGpuStore.getState().appearanceTransitionTarget).toBeNull();
  });

  it('keeps the flood translucent while the crystal lights the white frame', () => {
    expect(APPEARANCE_TO_WHITE_MS).toBeLessThan(APPEARANCE_FROM_WHITE_MS * 0.7);
    expect(appearanceTransitionSample(0)).toMatchObject({ surge: 0, flood: 0, whiteAlpha: 0 });
    const middle = appearanceTransitionSample(0.5);
    expect(middle.surge).toBeGreaterThan(middle.flood);
    expect(middle.spin).toBeCloseTo(1);
    expect(appearanceTransitionSample(0.6).floodAlpha).toBeLessThanOrEqual(0.7);
    expect(appearanceTransitionSample(1)).toMatchObject({ flood: 1, floodAlpha: 0, whiteAlpha: 1 });
    expect(appearanceTransitionSample(1).spin).toBeCloseTo(0);
    expect(appearanceRevealSample(0)).toEqual({ whiteAlpha: 1, colourAlpha: 0 });
    expect(appearanceRevealSample(0.5).whiteAlpha).toBeLessThan(0.2);
    expect(appearanceRevealSample(0.5).colourAlpha).toBeGreaterThan(0.9);
    expect(appearanceRevealSample(1)).toEqual({ whiteAlpha: 0, colourAlpha: 0 });
  });
});
