/* global document, window, getComputedStyle */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Local, fixture-only visual coverage; shares viz:shot's browser and API stubs. */
export async function captureUiMatrix(page, directory) {
  await mkdir(directory, { recursive: true });
  const overlays = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name)
      .find(url => /\/store\.(?:ts|js)(?:\?|$)/.test(url));
    const { useGpuStore } = await import(url);
    const state = useGpuStore.getState();
    return Object.fromEntries(['accountMenuOpen', 'themeDropdownOpen', 'notificationsMenuOpen', 'tuningPanelOpen']
      .map(key => [key, state[key]]));
  });
  const variants = [390, 528, 768, 1024, 1440, 1920].flatMap(width =>
    ['overview', 'focus'].map(camera => ({ width, height: 960, camera, theme: 'nocturne', locale: 'en' })));
  for (const theme of ['aurora', 'amethyst', 'copper', 'snow']) {
    variants.push({ width: 1440, height: 960, camera: 'focus', theme, locale: 'en' });
  }
  for (const locale of ['fr', 'ar', 'de']) {
    for (const width of [390, 1440]) variants.push({ width, height: 960, camera: 'focus', theme: 'nocturne', locale });
  }
  variants.push({ width: 390, height: 960, camera: 'focus', theme: 'nocturne', locale: 'en', reducedMotion: true });
  variants.push({ width: 720, height: 480, camera: 'focus', theme: 'nocturne', locale: 'en', zoom: 2 });
  const manifest = [];
  for (const variant of variants) {
    await page.setViewport({ width: variant.width, height: variant.height, deviceScaleFactor: variant.zoom ?? 1 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: variant.reducedMotion ? 'reduce' : 'no-preference' }]);
    await page.evaluate(async ({ camera, theme, locale }) => {
      const storeUrl = performance.getEntriesByType('resource').map(entry => entry.name)
        .find(url => /\/store\.(?:ts|js)(?:\?|$)/.test(url));
      if (!storeUrl) throw new Error('The application store module was not loaded');
      const { useGpuStore } = await import(storeUrl);
      if (useGpuStore.getState().view !== window.__ATOMA_VIZ_TEST__.view) throw new Error('Audit did not resolve the application store');
      useGpuStore.setState({ sceneCameraMode: camera });
      window.__ATOMA_VIZ_TEST__.dispatch(`appearance.select.${theme}`);
      window.__ATOMA_VIZ_TEST__.dispatch(`locale.select.${locale}`);
    }, variant);
    await page.waitForFunction(({ camera, theme, locale }) => {
      const app = document.querySelector('.gpu-app');
      const plane = document.querySelector('.gpu-scene-camera');
      return app?.dataset.theme === theme && app.dataset.themeTransition === 'idle' &&
        document.documentElement.lang === locale && plane?.dataset.sceneCameraMode === camera &&
        plane.dataset.sceneCameraMotion === 'settled';
    }, { timeout: 15000 }, variant);
    // Palette selection intentionally closes menus. Reopen the requested
    // fixture state only after that transition has finished.
    await page.evaluate(async overlays => {
      const url = performance.getEntriesByType('resource').map(entry => entry.name)
        .find(url => /\/store\.(?:ts|js)(?:\?|$)/.test(url));
      const { useGpuStore } = await import(url);
      useGpuStore.setState(overlays);
    }, overlays);
    // Resizes also relayout the retained crystal and the masked rail at settle.
    await page.evaluate(() => new Promise(resolveFrame => setTimeout(resolveFrame, 900)));
    await page.evaluate(() => {
      const proposal = document.querySelector('.gpu-assistant-proposal');
      const log = proposal?.closest('.gpu-assistant-log');
      if (log) log.scrollTop = log.scrollHeight;
    });
    const geometry = await page.evaluate(() => ({
      pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      nativeOverflow: [...document.querySelectorAll('.gpu-settings-panel, .gpu-announce-form, .gpu-assistant-log')]
        .filter(node => node.checkVisibility()).filter(node => node.scrollWidth > node.clientWidth + 1)
        .map(node => node.className),
      canvases: document.querySelectorAll('.gpu-ui-host canvas').length,
      errors: (window.__ATOMA_VIZ_TEST__?.renderer.visibleLabels ?? []).filter(label => /^HTTP \d{3}(?:\s|$)/.test(label)),
    }));
    const observedState = await page.evaluate(async () => {
      const storeUrl = performance.getEntriesByType('resource').map(entry => entry.name)
        .find(url => /\/store\.(?:ts|js)(?:\?|$)/.test(url));
      const { useGpuStore } = await import(storeUrl);
      const state = useGpuStore.getState();
      return Object.fromEntries(['view', 'settingsTab', 'projectSection', 'sentinelSection',
        'compactDetailView', 'selectedDocsTheme', 'resultRunId', 'runActivityOpen',
        'accountMenuOpen', 'themeDropdownOpen', 'notificationsMenuOpen', 'tuningPanelOpen', 'projectOverviewCollapsed']
        .map(key => [key, state[key]]));
    });
    for (const [key, open] of Object.entries(overlays)) {
      if (observedState[key] !== open) throw new Error(`Fixture overlay changed: ${key}`);
    }
    const file = `${variant.width}-${variant.camera}-${variant.theme}-${variant.locale}${variant.reducedMotion ? "-reduced-motion" : ""}${variant.zoom ? "-zoom-2" : ""}.png`;
    await page.screenshot({ path: resolve(directory, file) });
    if (variant.width === 1440 && variant.camera === 'focus' && variant.locale === 'en') {
      // Opaque swatches pass through Chrome's actual theme filter. Their centre
      // pixels let the report measure contrast without approximating CSS matrices.
      const colors = ['#182941', '#223754', '#2b4668', '#e6edf7', '#a8b4cc', '#a8b4cc', '#6ea8ff', '#4ade80', '#fbbf24', '#f87171', '#22d3ee', '#e879f9'];
      await page.evaluate(async colors => {
        const { readableTextColor } = await import('/text-contrast.ts');
        const theme = document.querySelector('.gpu-app').dataset.theme;
        colors = colors.map((color, index) => index < 3 || index === 5 ? color : `#${readableTextColor(Number.parseInt(color.slice(1), 16), theme).toString(16).padStart(6, '0')}`);
        const strip = document.createElement('div');
        strip.id = 'ui-contrast-swatches';
        strip.style.cssText = 'position:fixed;left:0;top:0;height:24px;display:flex;z-index:2147483647;';
        strip.style.filter = getComputedStyle(document.querySelector('.gpu-app')).getPropertyValue('--appearance-filter');
        for (const color of colors) {
          const patch = document.createElement('div');
          patch.style.cssText = `width:24px;height:24px;background:${color};`;
          strip.append(patch);
        }
        document.body.append(strip);
      }, colors);
      await page.screenshot({ path: resolve(directory, `contrast-${variant.theme}.png`), clip: { x: 0, y: 0, width: colors.length * 24, height: 24 } });
      await page.evaluate(() => document.getElementById('ui-contrast-swatches').remove());
    }
    manifest.push({ ...variant, file, geometry, observedState });
    console.log(`UI matrix ${file}: ${JSON.stringify(geometry)}`);
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const failures = manifest.filter(entry => entry.geometry.pageOverflow || entry.geometry.nativeOverflow.length || entry.geometry.errors.length);
  if (failures.length) throw new Error(`UI overflow: ${failures.map(entry => entry.file).join(', ')}`);
}
