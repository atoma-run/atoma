/** Shared, decorative 24px stroke geometry for DOM and GPU controls. */
export const BUTTON_ICON_PATHS = {
  back: 'M19 12H5 M11 6L5 12L11 18',
  forward: 'M5 12H19 M13 6L19 12L13 18',
  folder: 'M3 7V5H9L12 8H21V20H3Z',
  file: 'M5 3H14L19 8V21H5Z M14 3V8H19 M8 12H16 M8 16H16',
  copy: 'M9 9H21V21H9Z M15 5V3H3V15H5',
  download: 'M12 3V15 M7 10L12 15L17 10 M4 16V21H20V16',
  refresh: 'M20 10A8 8 0 1 0 19 17 M20 3V10H13',
  close: 'M6 6L18 18 M18 6L6 18',
  check: 'M4 12L9 17L20 6',
  plus: 'M12 4V20 M4 12H20',
  trash: 'M3 6H21 M9 6V3H15V6 M6 6L7 21H17L18 6 M10 10V17 M14 10V17',
  save: 'M4 3H17L21 7V21H3V3Z M7 3V9H17V3 M7 21V14H17V21',
  settings: 'M4 6H20 M4 12H20 M4 18H20 M8 3V9 M16 9V15 M10 15V21',
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  user: 'M16 7A4 4 0 1 1 8 7A4 4 0 1 1 16 7 M4 21V19a8 8 0 0 1 16 0V21',
  logout: 'M10 3H4V21H10 M10 12H21 M16 7L21 12L16 17',
  bell: 'M5 17H19L17 14V9A5 5 0 0 0-10 0V14Z M10 21H14',
  clock: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12 M12 6V12L16 14',
  play: 'M7 4L20 12L7 20Z',
  stop: 'M5 5H19V19H5Z',
  eye: 'M2 12Q12-2 22 12Q12 26 2 12 M15 12A3 3 0 1 1 9 12A3 3 0 1 1 15 12',
  globe: 'M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12 M3 12H21 M12 3C6 8 6 16 12 21C18 16 18 8 12 3',
  palette: 'M12 3A9 9 0 1 0 0 18H14Q17 21 15 17Q14 14 18 14H19Q23 14 21 9Q19 3 12 3 M7 9H8 M11 6H12 M16 8H17',
  code: 'M8 6L2 12L8 18 M16 6L22 12L16 18 M14 3L10 21',
  send: 'M3 3L22 12L3 21L7 12Z M7 12H22',
  key: 'M11 8A5 5 0 1 1 1 8A5 5 0 1 1 11 8 M10 11L20 21 M16 17L19 14 M19 20L22 17',
  down: 'M5 9L12 16L19 9',
} as const;
export type ButtonIconKind = keyof typeof BUTTON_ICON_PATHS;
export const BUTTON_ICON_SIZE = 14;
export const BUTTON_ICON_SPACE = 20;

/** One chevron geometry for native disclosures/selects and canvas controls. */
export const CHEVRON_SIZE = BUTTON_ICON_SIZE;
export const CHEVRON_SPACE = BUTTON_ICON_SPACE;
export const CHEVRON_CSS_VARS = {
  '--gpu-chevron-size': `${CHEVRON_SIZE}px`,
  '--gpu-chevron-image': `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${BUTTON_ICON_PATHS.down}" fill="none" stroke="#9fb0c9" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`)}")`,
};

/** Control identities, never translated copy, determine GPU pictograms. */
export function buttonIconKind(id: string): ButtonIconKind {
  if (id === 'project.section.conversation') return 'send';
  if (id === 'project.section.runs') return 'play';
  if (id === 'project.section.preview') return 'eye';
  if (id === 'project.section.files') return 'folder';
  if (id === 'project.section.result') return 'file';
  if (/^(result|workspace|activity)\.close$|^run.event.close$|^activity.files$|^workspace.parent$/.test(id)) return 'back';
  if (/^activity.source\./.test(id)) return 'code';
  if (/^activity.collapse\.|\.more$/.test(id)) return 'down';
  if (/\.prev$|^activity.newer$/.test(id)) return 'back';
  if (id === 'result.copy') return 'copy';
  if (id === 'result.details') return 'code';
  if (/^result.download$/.test(id)) return 'download';
  if (id === 'run.preview.stop') return 'stop';
  if (/^run.preview\./.test(id)) return 'eye';
  if (/^workspace.project$|^project.select\.|^activity.open$/.test(id)) return 'folder';
  if (/^workspace.path\.|^activity.file\.|^result\.|^docs\.|^journal\./.test(id)) return 'file';
  if (/^locale\./.test(id)) return 'globe';
  if (/^appearance\./.test(id)) return 'palette';
  if (/settings|^tuning\./.test(id)) return 'settings';
  if (/^auth.(signOut|switchAccount)$/.test(id)) return 'logout';
  if (/^org\.|^admin\.|^account\./.test(id)) return 'user';
  if (/^skill\.|^registry\./.test(id)) return 'code';
  if (/^notification|^push\./.test(id)) return 'bell';
  return 'forward';
}
