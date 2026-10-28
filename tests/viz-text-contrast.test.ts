import { describe, expect, it } from 'vitest';
import { APPEARANCE_THEMES, GPU_COLORS } from '../src/viz/client-gl/theme.js';
import { readableTextColor, textContrast } from '../src/viz/client-gl/text-contrast.js';

describe('theme-aware text contrast', () => {
  it.each(APPEARANCE_THEMES)('keeps numbers readable on solid status badges in $key', ({ key }) => {
    for (const background of [GPU_COLORS.success, GPU_COLORS.warning, GPU_COLORS.error, GPU_COLORS.primary, GPU_COLORS.muted]) {
      const color = readableTextColor(GPU_COLORS.panel, key, background);
      expect(textContrast(color, background, key)).toBeGreaterThanOrEqual(5);
      expect(readableTextColor(GPU_COLORS.panel, key, background)).toBe(color);
    }
  });
  it.each(APPEARANCE_THEMES)('keeps semantic text readable in $key without changing surface tokens', ({ key }) => {
    const colors = [0xa9b5ca, 0xca98a5, GPU_COLORS.text, GPU_COLORS.muted, GPU_COLORS.primary, GPU_COLORS.success,
      GPU_COLORS.error, GPU_COLORS.warning, GPU_COLORS.magenta, GPU_COLORS.cyan, ...Object.values(GPU_COLORS.tiers)];
    for (const color of colors) {
      const text = readableTextColor(color, key);
      for (const background of [GPU_COLORS.panel, GPU_COLORS.panelRaised, GPU_COLORS.panelHover]) {
        expect(textContrast(text, background, key)).toBeGreaterThanOrEqual(5);
      }
      expect(readableTextColor(color, key)).toBe(text);
    }
  });
});
