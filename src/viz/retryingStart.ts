/**
 * Start a service that depends on another process, retrying in the background
 * until it succeeds. `first` settles with the first attempt, so a request never
 * waits on the retries; `current()` holds the started value once any attempt
 * succeeded.
 *
 * Project hosting needs the hosting launcher's socket at web startup. Started
 * once, a launcher that was restarting at that moment (it now restarts on a
 * release change, src/launcher/releaseWatch.ts) left hosting unavailable for
 * the whole life of the web process.
 */
export function retryingStart<T>(start: () => Promise<T>, options: {
  retryMs?: number;
  onFailure?(error: unknown, attempt: number): void;
  schedule?: (run: () => void, ms: number) => { unref?(): unknown };
} = {}): { first: Promise<T>; current(): T | undefined } {
  let value: T | undefined;
  let attempt = 0;
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const tryOnce = async (): Promise<T> => {
    attempt += 1;
    try {
      value = await start();
      return value;
    } catch (error) {
      options.onFailure?.(error, attempt);
      schedule(() => { void tryOnce().catch(() => undefined); }, options.retryMs ?? 10_000).unref?.();
      throw error;
    }
  };
  const first = tryOnce();
  first.catch(() => undefined);
  return { first, current: () => value };
}
