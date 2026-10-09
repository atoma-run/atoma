/* global requestAnimationFrame */
/** Exercise the minimap through the painted canvas, including camera projection. */
export async function assertTimelineMinimap(page, { leaveHovered = false } = {}) {
  const prefix = 'run.timeline.row.';
  await page.waitForFunction(key => globalThis.__ATOMA_GPU__?.hitTargets().some(target => target.id.startsWith(key)),
    { timeout: 30_000 }, prefix);
  const targets = await page.evaluate(key => globalThis.__ATOMA_GPU__.hitTargets()
    .filter(target => target.id.startsWith(key)).map(target => target.id), prefix);
  const first = targets[0];
  const last = targets.at(-1);
  if (targets.length < 3) throw new Error('Minimap probe needs a run with recorded events');
  const pointFor = async id => page.evaluate(async targetId => {
    for (let frame = 0; frame < 3; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    const handle = globalThis.__ATOMA_GPU__;
    const target = handle.hitTargets().find(entry => entry.id === targetId);
    if (!target) throw new Error(`Minimap target missing: ${targetId}`);
    return handle.projectRendererPoint(target.x + target.width / 2, target.y + target.height / 2);
  }, id);
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
  const end = await pointFor(last);
  await page.mouse.click(end.x, end.y);
  await page.waitForFunction(ids => {
    const current = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith('event.')).map(target => target.id);
    return JSON.stringify(current) !== JSON.stringify(ids);
  }, { timeout: 10_000 }, before);
  const start = await pointFor(first);
  await page.mouse.click(start.x, start.y);
  await page.waitForFunction(ids => {
    const current = globalThis.__ATOMA_GPU__.hitTargets().filter(target => target.id.startsWith('event.')).map(target => target.id);
    return JSON.stringify(current) === JSON.stringify(ids);
  }, { timeout: 10_000 }, before);
  // At the top, visible event cards follow the same newest-first row order.
  // Choose a sampled event that is also visible so its identity comes from
  // the main timeline, independently of the minimap's activation handler.
  const selectedTarget = targets.find(id => {
    const row = Number(id.slice(prefix.length));
    return row >= 1 && row <= before.length;
  });
  if (!selectedTarget) throw new Error('Minimap selection probe needs a sampled visible event');
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
    const reset = await pointFor(first);
    await page.mouse.click(reset.x, reset.y);
    await page.waitForFunction(id => !globalThis.__ATOMA_GPU__.app.stage.getChildByLabel(`event-detail:${id}`, true),
      { timeout: 10_000 }, expectedEventId);
    await page.mouse.move(0, 0);
  }
  console.log('viz timeline minimap ok: immediate left-side preview, oldest/newest navigation, matching event detail');
}
