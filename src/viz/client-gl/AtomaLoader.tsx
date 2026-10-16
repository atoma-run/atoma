import { useEffect, useRef } from 'react';
import {
  ACTIVITY_CRYSTAL_FACET_SLOTS,
  ACTIVITY_CRYSTAL_LOCAL_SIZE,
  LOADING_CRYSTAL_COLOR,
  activityCrystalFrame,
  cssColor,
} from './activity-crystal.js';
import { prefersReducedMotion } from './renderer/motion.js';

/**
 * THE ONE LOADING NOTICE IN THE DOM: the beadless activity crystal, turning,
 * beside "Loading <what>". The canvas twin is `renderer/loading-notice.ts`;
 * both draw the frame of `activity-crystal.ts`. SVG, never a canvas: the GPU
 * client keeps exactly one. The facets are rewritten in place from one rAF,
 * outside React, and the loop stops while the document is hidden.
 */
export function AtomaLoader({ label, size = 18, className }: {
  /** "Loading <what>…", already translated. */
  label: string;
  size?: number;
  className?: string;
}) {
  const group = useRef<SVGGElement>(null);
  useEffect(() => {
    const root = group.current;
    if (!root) return undefined;
    const polygons = [...root.querySelectorAll('polygon')];
    let frame = 0;
    const paint = () => {
      const { facets } = activityCrystalFrame(performance.now(), LOADING_CRYSTAL_COLOR, prefersReducedMotion());
      polygons.forEach((polygon, index) => {
        const facet = facets[index];
        if (!facet) { polygon.setAttribute('points', ''); return; }
        polygon.setAttribute('points', facet.points.join(' '));
        polygon.setAttribute('fill', cssColor(facet.color));
      });
    };
    const loop = () => {
      paint();
      frame = document.hidden || prefersReducedMotion() ? 0 : requestAnimationFrame(loop);
    };
    const resume = () => { if (!frame) loop(); };
    loop();
    document.addEventListener('visibilitychange', resume);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  // The front-facing facet count varies with the turn: one slot per mesh
  // facet, and an unused slot is left empty.
  return <p className={`gpu-loader${className ? ` ${className}` : ''}`} role="status">
    <svg className="gpu-loader-crystal" width={size} height={size}
      viewBox={`0 0 ${ACTIVITY_CRYSTAL_LOCAL_SIZE} ${ACTIVITY_CRYSTAL_LOCAL_SIZE}`} aria-hidden="true" focusable="false">
      <g ref={group}>{Array.from({ length: ACTIVITY_CRYSTAL_FACET_SLOTS }, (_, index) => <polygon key={index} />)}</g>
    </svg>
    <span>{label}</span>
  </p>;
}
