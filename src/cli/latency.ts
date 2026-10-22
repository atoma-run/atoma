import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { withTraceDocument } from '../contracts/traceFields.js';
import { runtimeTimingSchema, timingUnionMs, type RuntimeTiming } from '../contracts/runtimeTiming.js';

type Interval = Pick<RuntimeTiming, 'startedAt' | 'durationMs'>;

/** Read one bounded event at a time; never materialize an entire large trace. */
export function readLatency(path: string) {
  return withTraceDocument(path, document => {
    const timings: RuntimeTiming[] = [];
    const calls: Interval[] = [], tools: Interval[] = [];
    let unavailableEvents = 0, omittedTimings = 0;
    const takeTimings = (value: unknown) => {
      if (!Array.isArray(value)) return;
      for (const item of value) {
        const parsed = runtimeTimingSchema.safeParse(item);
        if (parsed.success) timings.push(parsed.data);
        else omittedTimings++;
      }
    };
    const sidecar = path + '.timings.jsonl';
    if (existsSync(sidecar)) {
      const stat = lstatSync(sidecar);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 ** 2) throw new Error('Invalid or oversized timing sidecar');
      for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
        if (!line) continue;
        try { takeTimings([JSON.parse(line) as unknown]); } catch { omittedTimings++; }
      }
    }
    const top = document.fields.get('timings');
    if (top) takeTimings(document.read(top));
    for (const range of document.events ?? []) {
      let event: Record<string, unknown>;
      try { event = document.read(range) as Record<string, unknown>; }
      catch { unavailableEvents++; continue; }
      if (!event || typeof event !== 'object') { unavailableEvents++; continue; }
      if (typeof event['ts'] === 'number' && typeof event['durationMs'] === 'number' &&
        Number.isFinite(event['ts']) && Number.isFinite(event['durationMs']) && event['durationMs'] >= 0) {
        const interval = { startedAt: event['ts'], durationMs: event['durationMs'] };
        if (event['kind'] === 'llm') calls.push(interval);
        if (event['kind'] === 'tool') tools.push(interval);
      }
      takeTimings(event['timings']);
      if (typeof event['omittedTimings'] === 'number') omittedTimings += event['omittedTimings'];
    }
    const phases = Object.fromEntries(runtimeTimingSchema.shape.phase.options.map(phase => {
      const values = timings.filter(timing => timing.phase === phase);
      return [phase, { recorded: values.length > 0, count: values.length,
        unionMs: values.length ? timingUnionMs(values) : null,
        durationsMs: values.map(value => value.durationMs) }];
    }));
    return { phases, llmEnvelopeUnionMs: timingUnionMs(calls), toolUnionMs: timingUnionMs(tools),
      llmEnvelopeOutsideToolsMs: timingUnionMs([...calls, ...tools]) - timingUnionMs(tools),
      unavailableEvents, omittedTimings,
      note: 'Intervals overlap. Response envelopes include tools, transport and waits; outside-tools time is not pure inference. Missing timing is unknown, never zero.' };
  });
}

if (process.argv[1] && /latency\.(ts|js)$/.test(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help') console.log('Usage: latency trace.json');
    else if (args.length !== 1 || args[0]!.startsWith('--')) throw new Error('Usage: latency trace.json');
    else console.log(JSON.stringify(readLatency(args[0]!), null, 2));
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
