import { GPU_COLORS, type AppearanceTheme } from './theme.js';

type RGB = readonly [number, number, number];
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const rgb = (color: number): RGB => [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255];
const matrix = (color: RGB, rows: readonly RGB[]): RGB => rows.map(row =>
  clamp(row[0] * color[0] + row[1] * color[1] + row[2] * color[2])) as unknown as RGB;

/** CSS Filter Effects matrices, in the same order as the shared theme filter. */
export function themeColor(color: number, theme: AppearanceTheme): RGB {
  let value = rgb(color);
  if (theme === 'nocturne') return value;
  const angle = (theme === 'aurora' ? -24 : theme === 'amethyst' ? 38 : theme === 'snow' ? 180 : 0) * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  if (theme === 'snow') value = value.map(channel => 1 - channel) as unknown as RGB;
  value = matrix(value, [
    [.213 + c * .787 - s * .213, .715 - c * .715 - s * .715, .072 - c * .072 + s * .928],
    [.213 - c * .213 + s * .143, .715 + c * .285 + s * .140, .072 - c * .072 - s * .283],
    [.213 - c * .213 - s * .787, .715 - c * .715 + s * .715, .072 + c * .928 + s * .072],
  ]);
  const saturation = theme === 'snow' ? 1.25 : theme === 'copper' ? 1.3 : 1.14;
  value = matrix(value, [
    [.213 + .787 * saturation, .715 - .715 * saturation, .072 - .072 * saturation],
    [.213 - .213 * saturation, .715 + .285 * saturation, .072 - .072 * saturation],
    [.213 - .213 * saturation, .715 - .715 * saturation, .072 + .928 * saturation],
  ]);
  if (theme === 'copper') {
    const amount = .85;
    value = matrix(value, [[1 - .607 * amount, .769 * amount, .189 * amount],
      [.349 * amount, 1 - .314 * amount, .168 * amount], [.272 * amount, .534 * amount, 1 - .869 * amount]]);
  }
  if (theme === 'snow') value = value.map(channel => clamp(channel * 1.08 - .04)) as unknown as RGB;
  return value;
}

function luminance(color: RGB): number {
  const linear = color.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return linear[0]! * .2126 + linear[1]! * .7152 + linear[2]! * .0722;
}
export function textContrast(foreground: number, background: number, theme: AppearanceTheme): number {
  const a = luminance(themeColor(foreground, theme)), b = luminance(themeColor(background, theme));
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
const cache = new Map<string, number>();
/** Text alone yields towards white before the filter (towards dark in Snow).
 * The original semantic hue, surfaces, crystal and materials remain intact.
 * A supplied badge fill chooses the readable dark or light endpoint instead.
 * Cache per color/theme/background: style creation only, never a GPU frame.
 */
export function readableTextColor(color: number, theme: AppearanceTheme, background?: number): number {
  const key = `${theme}:${color}:${background ?? 'panels'}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const backgrounds = background === undefined ? [GPU_COLORS.panel, GPU_COLORS.panelRaised, GPU_COLORS.panelHover] : [background];
  const target = background === undefined || textContrast(0xffffff, background, theme) >= textContrast(0x000000, background, theme)
    ? 1 : 0;
  let adjusted = color;
  for (let step = 0; step <= 20; step++) {
    const amount = step / 20;
    const channels = rgb(color).map(channel => Math.round((channel + (target - channel) * amount) * 255));
    adjusted = (channels[0]! << 16) | (channels[1]! << 8) | channels[2]!;
    if (backgrounds.every(background => textContrast(adjusted, background, theme) >= 5)) break;
  }
  cache.set(key, adjusted);
  return adjusted;
}
