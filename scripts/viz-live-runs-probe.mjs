/* global document, requestAnimationFrame */

/** Exercise the actual Pixi controls and the browser's live query, with HTTP fixtures. */
export async function assertLiveRuns(page, { runs, updateRuns, followLabel }) {
  const click = async id => {
    await page.waitForFunction(targetId => {
      const handle = globalThis.__ATOMA_GPU__;
      const row = handle?.hitTargets().find(entry => entry.id === targetId);
      if (!row || document.querySelector('.gpu-scene-camera')?.dataset.sceneCameraMotion !== 'settled') return false;
      if (document.querySelector('.gpu-cube')?.dataset.cubeTurn !== 'idle') return false;
      const point = handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2);
      return document.elementFromPoint(point.x, point.y)?.classList.contains('gpu-ui-canvas');
    }, { timeout: 15_000 }, id);
    const point = await page.evaluate(async targetId => {
      for (let frame = 0; frame < 2; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      const handle = globalThis.__ATOMA_GPU__;
      const row = handle.hitTargets().find(entry => entry.id === targetId);
      return handle.projectRendererPoint(row.x + row.width / 2, row.y + row.height / 2);
    }, id);
    await page.mouse.click(point.x, point.y);
  };
  const waitForList = () => page.waitForFunction(expected => {
    const region = document.querySelector('section[aria-label="Live runs"]');
    return region && expected.every(row => region.textContent.includes(row.orgName)) &&
      region.querySelectorAll('button').length === expected.filter(row => row.traceId).length;
  }, { timeout: 15_000 }, runs);
  // Leave first so entering the admin view is itself a real canvas navigation.
  await click('nav.runs');
  await click('nav.liveRuns');
  await waitForList();
  await click(`liveRuns.run.${runs.find(run => run.traceId).projectRunId}`);
  await page.waitForFunction(label =>
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.trim() === 'Runs' &&
    document.querySelector('.gpu-run-input')?.value === label,
  { timeout: 15_000 }, followLabel).catch(async error => {
    const actual = await page.evaluate(() => ({
      selected: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
      run: document.querySelector('.gpu-run-input')?.value,
      status: document.querySelector('[data-viz-live]')?.textContent,
    }));
    throw new Error(`Live run navigation failed: ${JSON.stringify({ expected: followLabel, actual })}`, { cause: error });
  });
  await click('nav.liveRuns');
  await waitForList();
  updateRuns([]);
  await page.waitForFunction(() =>
    document.querySelector('section[aria-label="Live runs"]')?.textContent.includes('No runs are currently running'),
  { timeout: 15_000 });
  updateRuns(runs);
  await waitForList();
  console.log('viz live runs ok: cross-org list, preparation, canvas navigation and automatic removal');
}
