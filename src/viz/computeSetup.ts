import { detectComputeTarget, type ComputeTarget } from '../contracts/computeSetup.js';
import type { Locale } from '../contracts/locales.js';
import { computeSetupCopy, computePairIcon } from './computeCopy.js';
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export const COMPUTE_DESKTOP_AVAILABLE = false;
export const COMPUTE_DESKTOP_RELEASE = 'https://github.com/atoma-run/atoma/releases/tag/compute-desktop-preview-20261018-2';
const assets = { 'mac-arm64': 'Atoma-Compute-0.4.0-mac-arm64.dmg', 'mac-x64': 'Atoma-Compute-0.4.0-mac-x64.dmg', 'windows-x64': 'Atoma-Compute-0.4.0-win-x64.exe' } as const;
/** Ordinary links keep both installation paths usable without JavaScript. */
export function computeSetupView(locale: Locale, url: URL, userAgent: string, manualContent: string, available = COMPUTE_DESKTOP_AVAILABLE): string {
  const copy = (key: string) => escape(computeSetupCopy(key, locale));
  const manual = url.searchParams.get('mode') === 'manual';
  const requested = url.searchParams.get('os');
  const target: ComputeTarget = requested && Object.hasOwn(assets, requested) ? requested as keyof typeof assets : detectComputeTarget(userAgent);
  const link = (mode: string, os?: string) => `/compute/setup?${new URLSearchParams({ lang: locale, mode, ...(os ? { os } : {}) })}`;
  const tabs = `<nav class="setup-tabs" aria-label="${copy('methods')}"><a ${!manual ? 'aria-current="page"' : ''} href="${escape(link('app', requested ?? undefined))}">${copy('appTab')}</a><a ${manual ? 'aria-current="page"' : ''} href="${escape(link('manual', requested ?? undefined))}">${copy('manualTab')}</a></nav>`;
  if (manual) return tabs + manualContent;
  const choices = Object.entries(assets).map(([os]) => `<a ${target === os ? 'aria-current="true"' : ''} href="${escape(link('app', os))}">${os === 'mac-arm64' ? 'macOS · Apple Silicon' : os === 'mac-x64' ? 'macOS · Intel' : 'Windows · x64'}</a>`).join('');
  const download = available && target in assets ? `${COMPUTE_DESKTOP_RELEASE.replace('/tag/', '/download/')}/${assets[target as keyof typeof assets]}` : null;
  return tabs + `<p>${copy('appIntro')}</p><h2>${copy('chooseSystem')}</h2><p>${copy(target === 'mac' ? 'macChip' : target === 'unsupported' ? 'unsupportedSystem' : target === 'unknown' ? 'unknownSystem' : 'detectedSystem')}</p><div class="actions">${choices}</div>` +
    (download ? `<p><a class="download" href="${download}">${computePairIcon('download')}${copy('downloadApp')}</a><a href="${download}.sha256">${copy('checksum')}</a></p>` : '') +
    `<p class="notice">${copy('previewNotice')} ${available ? `<a href="${COMPUTE_DESKTOP_RELEASE}">${copy('releaseDetails')}</a>` : copy('appSoon')}</p><h2>${copy('nextSteps')}</h2><ol><li>${copy(target === 'windows-x64' ? 'windowsInstall' : 'macInstall')}</li><li>${copy('guidedDocker')}</li><li>${copy('pairApp')}</li></ol><p>${copy('dockerConsent')}</p><a href="/">${copy('back')}</a>`;
}
