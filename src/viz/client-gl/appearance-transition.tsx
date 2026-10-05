import { useEffect, useRef, useState } from 'react';
import { setMarkSpinBoost } from './renderer/mark-clock.js';
import { readMarkCoreScreen, setMarkCoreSurge } from './renderer/mark-surge.js';
import { useGpuStore } from './store.js';

/** The bead charges first, then its light fills the viewport before reveal. */
export const APPEARANCE_TO_WHITE_MS = 2_300;
export const APPEARANCE_FROM_WHITE_MS = 1_200;
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
    whiteAlpha: smoothstep((p - 0.7) / 0.3),
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
  const frameRef = useRef(0);
  const revealTimerRef = useRef(0);

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
      setMarkCoreSurge(0);
      setMarkSpinBoost(0);
      phaseRef.current = 'reveal';
      setPhase('reveal');
      revealTimerRef.current = window.setTimeout(() => {
        revealTimerRef.current = 0;
        phaseRef.current = 'idle';
        setPhase('idle');
        useGpuStore.getState().finishAppearanceTransition();
      }, APPEARANCE_FROM_WHITE_MS);
    };
    frameRef.current = requestAnimationFrame(step);
  }, [target]);

  useEffect(() => () => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    if (revealTimerRef.current) window.clearTimeout(revealTimerRef.current);
    setMarkCoreSurge(0);
    setMarkSpinBoost(0);
  }, []);

  return { phase, floodRef, whiteRef };
}

export function AppearanceVeilLayer({
  phase,
  floodRef,
  whiteRef,
}: ReturnType<typeof useAppearanceTransition>) {
  if (phase === 'idle') return null;
  return (
    <div className="gpu-appearance-veil" data-phase={phase} aria-hidden="true">
      <div ref={floodRef} className="gpu-appearance-veil__flood" />
      <div ref={whiteRef} className="gpu-appearance-veil__white" />
    </div>
  );
}
