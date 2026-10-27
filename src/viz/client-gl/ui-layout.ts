import { GPU_LAYOUT } from './theme.js';
/** Presentation tokens shared by the canvas and its native form overlays. */
export const UI_SPACE = { xs: 4, sm: 8, md: 12, card: 16, section: 24, lg: 32, xl: 48 } as const;
export const UI_TYPE = { page: 24, section: 18, body: 16, dense: 14, meta: 13 } as const;
export const UI_LAYOUT = {
  frameContentTop: 46, settingsIntroHeight: 68,
  settingsWidth: 1200, settingsNavWidth: 240, formWidth: 960,
  controlHeight: 40, touchHeight: 48,
  splitBreakpoint: 900, overviewBreakpoint: 1200, runCompactBreakpoint: 600,
} as const;
export const UI_CSS_VARS = Object.fromEntries([
  ['--ui-frame-pad', `${UI_SPACE.card}px`],
  ['--ui-frame-gap', `${GPU_LAYOUT.gap}px`],
  ['--ui-frame-content-top', `${GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + UI_LAYOUT.frameContentTop}px`],
  ['--ui-settings-body-top', `${GPU_LAYOUT.headerHeight + GPU_LAYOUT.gap + UI_LAYOUT.frameContentTop + UI_LAYOUT.settingsIntroHeight}px`],
  ['--ui-frame-bottom', `${GPU_LAYOUT.gap + UI_SPACE.card}px`],
  ...Object.entries(UI_SPACE).map(([key, value]) => [`--ui-space-${key}`, `${value}px`]),
  ...Object.entries(UI_TYPE).map(([key, value]) => [`--ui-type-${key}`, `${value}px`]),
  ...Object.entries(UI_LAYOUT).map(([key, value]) => [`--ui-${key}`, `${value}px`]),
]);
