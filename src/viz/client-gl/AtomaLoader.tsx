import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  LOADING_CRYSTAL_INLINE_PX,
  LOADING_CRYSTAL_SECTION_PX,
  LOADING_CRYSTAL_SPRITE,
  LOADING_ENTER_MS,
  LOADING_LEAVE_MS,
} from './loading-crystal.js';
import { prefersReducedMotion } from './renderer/motion.js';

/**
 * THE ONE LOADING NOTICE IN THE DOM: the original crystal, turning, beside
 * "Loading <what>". The canvas twin is `renderer/loading-notice.ts`; both play
 * the sheet of `loading-crystal.ts` — here as a CSS sprite, so no script runs
 * per frame and the GPU client keeps its one canvas.
 */
export function AtomaLoader({ label, section = false, leaving = false, size, className }: {
  /** "Loading <what>…", already translated. */
  label: string;
  /**
   * The section has nothing to show yet: fill it and centre the notice both
   * ways, at twice the inline crystal (the canvas's `drawSectionLoading`).
   */
  section?: boolean;
  /** The content arrived: whiten and fade out (`useLoadingReveal`). */
  leaving?: boolean;
  size?: number;
  className?: string;
}) {
  const px = size ?? (section ? LOADING_CRYSTAL_SECTION_PX : LOADING_CRYSTAL_INLINE_PX);
  const { url, frames, turnMs } = LOADING_CRYSTAL_SPRITE;
  const crystal = {
    '--gpu-loader-size': `${px}px`,
    '--gpu-loader-frames': frames,
    '--gpu-loader-turn': `${turnMs}ms`,
    '--gpu-loader-sheet': `url(${url})`,
  } as CSSProperties;
  return <p className={`gpu-loader${section ? ' gpu-loader--section' : ''}${leaving ? ' gpu-loader--leaving' : ''}${className ? ` ${className}` : ''}`}
    role="status" aria-busy={!leaving}>
    <span className="gpu-loader-crystal" style={crystal} aria-hidden="true" />
    <span>{label}</span>
  </p>;
}

/**
 * Where a loading section stands: `loading` shows the notice, `leaving` plays
 * its exit over content kept invisible, `entering` fades the content in, then
 * `shown`. Only a load that ENDS plays the exit; content present from the
 * first render is simply shown. Reduced motion jumps to `shown`.
 */
export type LoadingPhase = 'loading' | 'leaving' | 'entering' | 'shown';

export function useLoadingReveal(loading: boolean): LoadingPhase {
  const [phase, setPhase] = useState<LoadingPhase>(loading ? 'loading' : 'shown');
  const wasLoading = useRef(loading);
  useEffect(() => {
    const was = wasLoading.current;
    wasLoading.current = loading;
    if (loading) {
      setPhase('loading');
      return undefined;
    }
    if (!was) return undefined;
    if (prefersReducedMotion()) {
      setPhase('shown');
      return undefined;
    }
    setPhase('leaving');
    const enter = setTimeout(() => setPhase('entering'), LOADING_LEAVE_MS);
    const shown = setTimeout(() => setPhase('shown'), LOADING_LEAVE_MS + LOADING_ENTER_MS);
    return () => {
      clearTimeout(enter);
      clearTimeout(shown);
    };
  }, [loading]);
  return phase;
}

/** True while the notice is on screen (loading, or leaving). */
export function loaderVisible(phase: LoadingPhase): boolean {
  return phase === 'loading' || phase === 'leaving';
}

/** The class the section's CONTENT takes: invisible behind the notice, then fading in. */
export function revealClass(phase: LoadingPhase): string {
  return loaderVisible(phase) ? ' gpu-loading-wait' : phase === 'entering' ? ' gpu-loading-enter' : '';
}
