import { translate } from './client/i18n-catalog.js';

/** Bundled independently: Vite replaces the client output directory. */
export const computePairCopy = (key: string): string => translate('en', `compute.pair.${key}`);

import { BUTTON_ICON_PATHS, BUTTON_ICON_SIZE } from './client-gl/button-icons.js';
export const computePairIcon = (kind: keyof typeof BUTTON_ICON_PATHS): string => `<svg aria-hidden="true" width="${BUTTON_ICON_SIZE}" height="${BUTTON_ICON_SIZE}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${BUTTON_ICON_PATHS[kind]}"/></svg>`;

import { isLocale } from '../contracts/locales.js';
export const computeSetupCopy = (key: string, locale: string): string => translate(isLocale(locale) ? locale : 'en', `compute.setup.${key}`);
