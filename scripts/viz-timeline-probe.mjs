/* global requestAnimationFrame */
/** Exercise the minimap through the painted canvas, including camera projection. */
export async function assertTimelineMinimap(page, { leaveHovered = false } = {}) {
  const prefix = 'run.timeline.row.';
  await page.waitForFunction(key => globalThis.__ATOMA_GPU__?.hitTargets().some(target => target.id.startsWith(key)),
    { timeout: 30_000 }, prefix);
  let targets = await page.evaluate(key => globalThis.__ATOMA_GPU__.hitTargets()
    .filter(target => target.id.startsWith(key)).map(target => target.id), prefix);
  const first = `${prefix}0`;
  if (targets.length < 3) throw new Error('Minimap probe needs a run with recorded events');
  const pointFor = async id => page.evaluate(async targetId => {
    for (let frame = 0; frame < 3; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    const handle = globalThis.__ATOMA_GPU__;
    const target = handle.hitTargets().find(entry => entry.id === targetId);
    if (!target) throw new Error(`Minimap target missing: ${targetId}`);
    return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
  }, id);
  const readRows = () => page.evaluate(key => globalThis.__ATOMA_GPU__.hitTargets()
    .filter(target => target.id.startsWith(key)).map(target => target.id), prefix);
  const wheelRail = async deltaY => {
    const rows = await readRows();
    const point = await pointFor(rows[Math.floor(rows.length / 2)]);
    await page.mouse.move(point.x, point.y);
    await page.mouse.wheel({ deltaY });
    await page.evaluate(async () => {
      for (let frame = 0; frame < 3; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    });
  };
  await wheelRail(-1000000);
  targets = await readRows();
  if (targets[0] !== first || targets.length > 40) throw new Error('Minimap window must start at row zero and show at most 40 bars');
  const indices = targets.map(id => Number(id.slice(prefix.length)));
  if (indices.some((row, i) => row !== i)) throw new Error('Minimap must not sample or skip cards');
  const hoveredId = targets[Math.floor(targets.length / 2)];
  const hover = await pointFor(hoveredId);
  await page.mouse.move(hover.x, hover.y);
  await page.evaluate(async id => {
    for (let frame = 0; frame < 2; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    const handle = globalThis.__ATOMA_GPU__;
    const target = handle.hitTargets().find(entry => entry.id === id);
    const bubble = handle.app.stage.getChildByLabel('hover-tooltip', true);
    if (!handle.tooltip().visible || !bubble?.visible) throw new Error('Minimap preview did not open on hover');
    if (bubble.x + bubble.width >= target.x) throw new Error('Minimap preview must stay left of the rail');
  }, hoveredId);
  const preview = await page.evaluate(() => globalThis.__ATOMA_GPU__.tooltip().text);
  if (!preview || preview.length > 1000) throw new Error('Minimap preview is empty or unbounded');
  const before = await page.evaluate(() => globalThis.__ATOMA_GPU__.hitTargets()
    .filter(target => target.id.startsWith('event.')).map(target => target.id));
  await wheelRail(1000000);
  const oldestRows = await readRows();
  const last = oldestRows.at(-1);
  const unchanged = await page.evaluate(() => globalThis.__ATOMA_GPU__.hitTargets()
    .filter(target => target.id.startsWith('event.')).map(target => target.id));
  if (JSON.stringify(unchanged) !== JSON.stringify(before)) throw new Error('Minimap wheel moved the central cards');
  const end = await pointFor(last);
  await page.mouse.click(end.x, end.y);
  await page.waitForFunction(ids => {
    const current = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith('event.')).map(target => target.id);
    return JSON.stringify(current) !== JSON.stringify(ids);
  }, { timeout: 10_000 }, before);
  await wheelRail(-1000000);
  const start = await pointFor(first);
  await page.mouse.click(start.x, start.y);
  await page.waitForFunction(ids => {
    const current = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith('event.')).map(target => target.id);
    return JSON.stringify(current) === JSON.stringify(ids);
  }, { timeout: 10_000 }, before);
  if (oldestRows.at(-1) !== targets.at(-1)) {
    const central = await pointFor(before[Math.floor(before.length / 2)]);
    await page.mouse.move(central.x, central.y);
    await page.mouse.wheel({ deltaY: 2200 });
    await page.waitForFunction(key => {
      const rows = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith(key));
      return Number(rows[0]?.id.slice(key.length)) > 0;
    }, { timeout: 10_000 }, prefix);
    // The main viewport must pull the rail away from row zero automatically.
    const followed = await readRows();
    const values = followed.map(id => Number(id.slice(prefix.length)));
    if (values.some((row, i) => row !== values[0] + i)) throw new Error('Following the cards skipped minimap rows');
    await page.mouse.wheel({ deltaY: -1000000 });
    await page.waitForFunction(ids => {
      const current = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith('event.')).map(target => target.id);
      return JSON.stringify(current) === JSON.stringify(ids);
    }, { timeout: 10_000 }, before);
    if ((await readRows())[0] !== first) throw new Error('Minimap did not follow the cards back to the top');
    const animatedId = targets.at(-2);
    const animatedPoint = await pointFor(animatedId);
    await page.mouse.click(animatedPoint.x, animatedPoint.y);
    const positions = await page.evaluate(async id => {
      const samples = [];
      const started = performance.now();
      while (performance.now() - started < 250) {
        const row = globalThis.__ATOMA_GPU__.hitTargets().find(target => target.id === id);
        if (row) samples.push(row.y);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return samples;
    }, animatedId);
    if (new Set(positions.map(y => Math.round(y * 10))).size < 3) {
      throw new Error('Clicked minimap bar did not glide through intermediate positions');
    }
    if (Math.abs(positions.at(-1) - positions.at(-2)) > 0.1) throw new Error('Minimap recenter did not settle');
    await wheelRail(-1000000);
    const resetPoint = await pointFor(first);
    await page.mouse.click(resetPoint.x, resetPoint.y);
    await page.waitForFunction(ids => {
      const current = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith('event.')).map(target => target.id);
      return JSON.stringify(current) === JSON.stringify(ids);
    }, { timeout: 10_000 }, before);
  }
  // At the top, visible event cards follow the same newest-first row order.
  // Choose an indexed event that is also visible so its identity comes from
  // the main timeline, independently of the minimap's activation handler.
  const selectedTarget = targets.find(id => {
    const row = Number(id.slice(prefix.length));
    return row >= 1 && row <= before.length;
  });
  if (!selectedTarget) throw new Error('Minimap selection probe needs an indexed visible event');
  const expectedEventId = before[Number(selectedTarget.slice(prefix.length)) - 1].slice('event.'.length);
  const select = await pointFor(selectedTarget);
  await page.mouse.click(select.x, select.y);
  await page.waitForFunction(id => !!globalThis.__ATOMA_GPU__.app.stage.getChildByLabel(`event-detail:${id}`, true),
    { timeout: 10_000 }, expectedEventId);
  if (leaveHovered) {
    const point = await pointFor(selectedTarget);
    await page.mouse.move(point.x, point.y);
    await page.waitForFunction(() => globalThis.__ATOMA_GPU__?.tooltip().visible === true, { timeout: 10_000 });
  } else {
    await wheelRail(-1000000);
    const reset = await pointFor(first);
    await page.mouse.click(reset.x, reset.y);
    await page.waitForFunction(id => !globalThis.__ATOMA_GPU__.app.stage.getChildByLabel(`event-detail:${id}`, true),
      { timeout: 10_000 }, expectedEventId);
    await page.mouse.move(0, 0);
  }
  console.log('viz timeline minimap ok: consecutive bounded bars, independent scrolling, immediate preview, oldest/newest navigation, matching event detail');
}
