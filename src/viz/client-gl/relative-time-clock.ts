import { relativeTime, relativeTimeParts, timestampMs } from './renderer/relative-time.js';

type Translate = (key: string, vars?: Record<string, unknown>) => string;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;

function tick() {
  for (const listener of [...listeners]) listener();
}

function syncVisibility() {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (!document.hidden && listeners.size) {
    timer = setInterval(tick, 1000);
    tick();
  }
}

/** One clock for DOM and canvas labels; no polling of server data. */
export function subscribeRelativeTime(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener('visibilitychange', syncVisibility);
    if (!document.hidden) timer = setInterval(tick, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    document.removeEventListener('visibilitychange', syncVisibility);
  };
}

/** Scene-owned relative labels: rebuild their layout only when the wording changes. */
export class RelativeTimeView {
  private labels: Array<{ at: string | number; t: Translate; locale: string; value: string }> = [];
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly onChange: () => void) {}

  format(at: string | number, t: Translate, locale: string): string {
    const value = relativeTime(at, t, locale);
    const ms = timestampMs(at);
    if (ms !== null && !relativeTimeParts(ms, Date.now()).exact) this.labels.push({ at, t, locale, value });
    return value;
  }

  clear() { this.labels = []; }

  private readonly refresh = () => {
    if (this.labels.some(({ at, t, locale, value }) => relativeTime(at, t, locale) !== value)) this.onChange();
  };

  start() {
    if (this.unsubscribe) return;
    this.unsubscribe = subscribeRelativeTime(this.refresh);
    this.refresh();
  }

  stop() {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
