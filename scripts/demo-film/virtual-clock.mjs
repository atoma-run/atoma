/* global window */
/**
 * A page-side virtual clock, installed with `evaluateOnNewDocument` BEFORE any
 * client script runs.
 *
 * The GPU client animates from `requestAnimationFrame` and `performance.now()`
 * alone (its timers are the same clock seen through `setTimeout`). Under the
 * software rasteriser a 4K frame takes far longer than 16 ms, so filming it in
 * real time yields a slideshow. This clock lets the film advance time by an
 * exact step per captured frame: every animation then plays at its authored
 * speed in the film, however slowly the machine renders it.
 *
 * Two modes:
 *   - real: time runs with the wall clock (offset kept continuous), used to
 *     load, navigate and settle between shots quickly;
 *   - manual: time only moves when the film calls `__demoClock.advance(ms)`,
 *     which fires due timers in order, then the queued animation frames.
 *
 * CSS transitions still run on the compositor's wall clock. The client's are
 * sub-second opacity fades, which simply finish between two captured frames.
 */
export function installVirtualClock() {
  const realNow = performance.now.bind(performance);
  const realDateNow = Date.now.bind(Date);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCaf = window.cancelAnimationFrame.bind(window);
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);

  const clock = {
    manual: false,
    base: realNow(),
    realAt: realNow(),
    dateOffset: realDateNow() - realNow(),
  };
  const now = () => (clock.manual ? clock.base : clock.base + (realNow() - clock.realAt));

  performance.now = () => now();
  Date.now = () => Math.floor(clock.dateOffset + now());

  let nextFrameId = 1;
  const frameQueue = new Map();
  const realFrameIds = new Map();
  const queueReal = (id, callback) => {
    realFrameIds.set(id, realRaf(() => {
      realFrameIds.delete(id);
      if (clock.manual) frameQueue.set(id, callback);
      else callback(now());
    }));
  };
  window.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    if (clock.manual) frameQueue.set(id, callback);
    else queueReal(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    frameQueue.delete(id);
    const real = realFrameIds.get(id);
    if (real !== undefined) {
      realCaf(real);
      realFrameIds.delete(id);
    }
  };

  let nextTimerId = 1;
  const timers = new Map();
  const arm = (timer) => {
    if (clock.manual) return;
    timer.realId = realSetTimeout(() => fire(timer), Math.max(0, timer.due - now()));
  };
  const run = (timer) => {
    if (timer.interval === null) timers.delete(timer.id);
    else {
      timer.due += timer.interval;
      arm(timer);
    }
    try {
      if (typeof timer.callback === 'function') timer.callback(...timer.args);
    } catch (error) {
      console.error(error);
    }
  };
  const fire = (timer) => {
    timer.realId = undefined;
    if (!timers.has(timer.id)) return;
    if (clock.manual && timer.due > now()) return;
    run(timer);
  };
  const addTimer = (callback, delay, args, repeat) => {
    const step = Math.max(repeat ? 1 : 0, Number(delay) || 0);
    const timer = { id: nextTimerId++, due: now() + step, callback, args, interval: repeat ? step : null, realId: undefined };
    timers.set(timer.id, timer);
    arm(timer);
    return timer.id;
  };
  const clearTimer = (id) => {
    const timer = timers.get(id);
    if (!timer) return;
    timers.delete(id);
    if (timer.realId !== undefined) realClearTimeout(timer.realId);
  };
  window.setTimeout = (callback, delay, ...args) => addTimer(callback, delay, args, false);
  window.setInterval = (callback, delay, ...args) => addTimer(callback, delay, args, true);
  window.clearTimeout = clearTimer;
  window.clearInterval = clearTimer;

  window.__demoClock = {
    now,
    isManual: () => clock.manual,
    /** Yield one REAL macrotask, so network answers land between steps. */
    yieldReal: () => new Promise((resolve) => realSetTimeout(resolve, 0)),
    setManual(on) {
      if (on === clock.manual) return;
      if (on) {
        clock.base = now();
        clock.manual = true;
        for (const timer of timers.values()) {
          if (timer.realId !== undefined) realClearTimeout(timer.realId);
          timer.realId = undefined;
        }
        // Frames already requested from the browser stay requested: when one
        // fires in manual mode, `queueReal` moves it into the virtual queue.
      } else {
        clock.realAt = realNow();
        clock.manual = false;
        for (const timer of timers.values()) arm(timer);
        const pending = [...frameQueue.entries()];
        frameQueue.clear();
        for (const [id, callback] of pending) queueReal(id, callback);
      }
    },
    /** Move virtual time forward by `ms`, firing timers then one frame. */
    async advance(ms) {
      const target = clock.base + ms;
      for (let guard = 0; guard < 500; guard++) {
        let next = null;
        for (const timer of timers.values()) {
          if (timer.due <= target && (!next || timer.due < next.due)) next = timer;
        }
        if (!next) break;
        clock.base = Math.max(clock.base, next.due);
        run(next);
        await Promise.resolve();
      }
      clock.base = target;
      const callbacks = [...frameQueue.values()];
      frameQueue.clear();
      for (const callback of callbacks) {
        try {
          callback(target);
        } catch (error) {
          console.error(error);
        }
      }
      await Promise.resolve();
    },
  };
}
