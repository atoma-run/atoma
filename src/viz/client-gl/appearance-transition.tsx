import { useEffect, useRef, useState } from 'react';
import { setMarkSpinBoost } from './renderer/mark-clock.js';
import { readMarkCoreScreen, setMarkCoreSurge } from './renderer/mark-surge.js';
import { useGpuStore } from './store.js';

/** The bead charges first, then its light fills the viewport before reveal. */
export const APPEARANCE_TO_WHITE_MS = 1_200;
export const APPEARANCE_FROM_WHITE_MS = 2_100;
// The solid sheet covers the corners, so the radial texture can stay bounded.
const FLOOD_DIAGONALS = 1.4;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

export function appearanceTransitionSample(progress: number) {
  const p = clamp01(progress);
  return {
    surge: smoothstep(p / 0.52),
    spin: Math.sin(Math.PI * p),
    flood: smoothstep((p - 0.2) / 0.8),
    floodAlpha: smoothstep((p - 0.16) / 0.54),
    whiteAlpha: smoothstep((p - 0.58) / 0.42),
  };
}

export function appearanceRevealSample(progress: number) {
  const p = clamp01(progress);
  return {
    whiteAlpha: 1 - smoothstep(p / 0.68),
    colourAlpha: smoothstep(p / 0.18) * (1 - smoothstep((p - 0.56) / 0.44)),
  };
}

type AppearancePhase = 'idle' | 'charge' | 'reveal';

/** One compositor flood; the Pixi crystal reads the same frame's surge. */
export function useAppearanceTransition() {
  const target = useGpuStore((state) => state.appearanceTransitionTarget);
  const [phase, setPhase] = useState<AppearancePhase>('idle');
  const phaseRef = useRef<AppearancePhase>('idle');
  const targetRef = useRef(target);
  const floodRef = useRef<HTMLDivElement | null>(null);
  const whiteRef = useRef<HTMLDivElement | null>(null);
  const colourRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef(0);

  useEffect(() => {
    targetRef.current = target;
    if (target === null || phaseRef.current !== 'idle') return;
    phaseRef.current = 'charge';
    setPhase('charge');
    let startedAt: number | null = null;
    const step = (now: number) => {
      if (startedAt === null) startedAt = now;
      const progress = clamp01((now - startedAt) / APPEARANCE_TO_WHITE_MS);
      const sample = appearanceTransitionSample(progress);
      setMarkCoreSurge(sample.surge);
      setMarkSpinBoost(sample.spin);
      const flood = floodRef.current;
      const white = whiteRef.current;
      if (flood && white) {
        const width = window.innerWidth;
        const height = window.innerHeight;
        const side = Math.hypot(width, height) * FLOOD_DIAGONALS;
        const bead = readMarkCoreScreen();
        const x = bead?.clientX ?? width / 2;
        const y = bead?.clientY ?? height / 2;
        flood.style.width = `${side}px`;
        flood.style.height = `${side}px`;
        flood.style.opacity = String(sample.floodAlpha);
        flood.style.transform =
          `translate3d(${x - side / 2}px, ${y - side / 2}px, 0) scale(${sample.flood})`;
        white.style.opacity = String(sample.whiteAlpha);
      }
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      frameRef.current = 0;
      // Only now is every pixel white; the new palette appears beneath it.
      const nextTheme = targetRef.current;
      if (nextTheme !== null) useGpuStore.getState().commitAppearanceTheme(nextTheme);
      if (flood) flood.style.opacity = '0';
      const colour = colourRef.current;
      if (colour) {
        const bead = readMarkCoreScreen();
        colour.style.setProperty('--appearance-origin-x', `${bead?.clientX ?? window.innerWidth / 2}px`);
        colour.style.setProperty('--appearance-origin-y', `${bead?.clientY ?? window.innerHeight / 2}px`);
      }
      setMarkCoreSurge(0);
      setMarkSpinBoost(0);
      phaseRef.current = 'reveal';
      setPhase('reveal');
      const revealStartedAt = now;
      const revealStep = (revealNow: number) => {
        const revealProgress = clamp01((revealNow - revealStartedAt) / APPEARANCE_FROM_WHITE_MS);
        const reveal = appearanceRevealSample(revealProgress);
        if (whiteRef.current) whiteRef.current.style.opacity = String(reveal.whiteAlpha);
        if (colourRef.current) colourRef.current.style.opacity = String(reveal.colourAlpha);
        if (revealProgress < 1) {
          frameRef.current = requestAnimationFrame(revealStep);
          return;
        }
        frameRef.current = 0;
        phaseRef.current = 'idle';
        setPhase('idle');
        useGpuStore.getState().finishAppearanceTransition();
      };
      frameRef.current = requestAnimationFrame(revealStep);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [target]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    setMarkCoreSurge(0);
    setMarkSpinBoost(0);
  }, []);

  return { phase, target, floodRef, whiteRef, colourRef };
}

export function AppearanceVeilLayer({
  phase,
  target,
  floodRef,
  whiteRef,
  colourRef,
}: ReturnType<typeof useAppearanceTransition>) {
  if (phase === 'idle') return null;
  return (
    <div className="gpu-appearance-veil" data-phase={phase} data-theme={target ?? undefined} aria-hidden="true">
      <div ref={floodRef} className="gpu-appearance-veil__flood" />
      <div ref={colourRef} className="gpu-appearance-veil__colour" />
      <div ref={whiteRef} className="gpu-appearance-veil__white" />
    </div>
  );
}
