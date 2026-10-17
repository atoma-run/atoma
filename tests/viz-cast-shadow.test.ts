import { describe, expect, it } from 'vitest';
import {
  AMBIENT_SHADOW_DENSITY,
  ambientShadowOffset,
  CAST_SHADOW_MAX_THROW_PX,
  castShadowEdges,
  castShadowTransform,
  type CastShadowInput,
} from '../src/viz/client-gl/renderer/cast-shadow.js';
import { POINTER_LIGHT_RADIUS_PX } from '../src/viz/client-gl/pointer-light.js';

/** A project row: 900px wide, 44px high. */
const row = { left: 100, top: 300, width: 900, height: 44 };

function edges(overrides: Partial<CastShadowInput>) {
  return castShadowEdges({ ...row, lightX: 0, lightY: 0, strength: 1, ...overrides });
}

describe('cast shadows under the pointer lamp', () => {
  it('rests on the ambient shadow when the lamp is absent', () => {
    const rest = ambientShadowOffset();
    expect(edges({ strength: 0 })).toEqual({
      left: rest.x, right: rest.x, top: rest.y, bottom: rest.y, density: AMBIENT_SHADOW_DENSITY,
    });
  });

  it('scales the ambient offset with depth so stacked layers separate', () => {
    const near = ambientShadowOffset(0.5);
    const deep = ambientShadowOffset(1.5);
    expect(deep.x).toBeGreaterThan(near.x);
    expect(deep.y).toBeGreaterThan(near.y);
  });

  it('spills outward on every side when the lamp is over a small surface', () => {
    const card = { left: 400, top: 300, width: 120, height: 40 };
    const spill = edges({ ...card, lightX: 460, lightY: 320 });
    expect(spill.left).toBeLessThan(0);
    expect(spill.right).toBeGreaterThan(0);
    expect(spill.top).toBeLessThan(0);
    expect(spill.bottom).toBeGreaterThan(0);
  });

  it('leaves the far edge of a wide surface on its ambient shadow', () => {
    // The lamp sits on the row, 600px from its left edge. A single blend for
    // the whole surface threw that edge 26px out (2026-10-17).
    const rest = ambientShadowOffset();
    const spill = edges({ lightX: row.left + 600, lightY: 322 });
    expect(spill.left).toBeCloseTo(rest.x, 2);
    expect(spill.right).toBeCloseTo(rest.x, 2);
  });

  it('throws the near edge far enough to see at the shipped lamp height', () => {
    // At a 240px lamp the largest throw was 1.9px: shadows nobody could see.
    let largest = 0;
    for (let distance = 0; distance <= 200; distance += 5) {
      const spill = edges({ lightX: row.left + distance, lightY: 322 });
      largest = Math.max(largest, -spill.left);
    }
    expect(largest).toBeGreaterThan(8);
  });

  it('never throws an edge further than the cap', () => {
    for (const lightHeight of [0.3, 1, 3]) {
      for (const depth of [1, 4]) {
        for (let distance = -300; distance <= 300; distance += 10) {
          const spill = edges({ lightX: row.left + distance, lightY: 322 + distance / 2, depth, lightHeight });
          for (const value of [spill.left, spill.right, spill.top, spill.bottom]) {
            expect(Math.abs(value)).toBeLessThanOrEqual(CAST_SHADOW_MAX_THROW_PX + 1e-9);
          }
        }
      }
    }
  });

  it('darkens the shadow under the lamp and leaves it ambient out of reach', () => {
    expect(edges({ lightX: row.left + 50, lightY: 322 }).density).toBeCloseTo(1, 6);
    expect(edges({ lightX: row.left + 50, lightY: 322 + POINTER_LIGHT_RADIUS_PX * 3 }).density)
      .toBeCloseTo(AMBIENT_SHADOW_DENSITY, 3);
  });

  it('moves continuously as the lamp sweeps across an edge', () => {
    let previous = edges({ lightX: row.left - 200, lightY: 322 }).left;
    for (let x = row.left - 199; x <= row.left + 200; x += 1) {
      const next = edges({ lightX: x, lightY: 322 }).left;
      expect(Math.abs(next - previous)).toBeLessThan(0.5);
      previous = next;
    }
  });

  it('answers ambient, not NaN, when an input is unplaceable', () => {
    const rest = ambientShadowOffset();
    for (const bad of [{ lightX: Number.NaN }, { strength: Number.NaN }, { left: Number.POSITIVE_INFINITY }]) {
      expect(edges(bad).left).toBe(rest.x);
    }
  });

  it('honours the live ambient reach and density', () => {
    const spill = edges({ strength: 0, ambientReach: 0, ambientDensity: 0.3 });
    expect(spill).toEqual({ left: 0, right: 0, top: 0, bottom: 0, density: 0.3 });
  });
});

describe('the one-transform projection for small shadows', () => {
  const icon = { left: 40, top: 300, width: 24, height: 24 };

  it('rests on the ambient shadow at scale 1 without the lamp', () => {
    const rest = ambientShadowOffset();
    expect(castShadowTransform({ ...icon, lightX: 0, lightY: 0, strength: 0 }))
      .toEqual({ ...rest, scale: 1 });
  });

  it('grows the shadow about the lamp when the lamp is over it', () => {
    const cast = castShadowTransform({ ...icon, lightX: 52, lightY: 312, strength: 1 });
    expect(cast.scale).toBeGreaterThan(1);
    expect(cast.x).toBeLessThan(0);
    expect(cast.y).toBeLessThan(0);
  });
});
