import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants, createBrotliCompress, createGzip } from 'node:zlib';

type TraceEncoding = 'br' | 'gzip' | 'identity';

/** Honour explicit exclusions and client weights; prefer Brotli on a tie. */
export function traceEncoding(header: string | undefined): TraceEncoding | null {
  if (!header?.trim()) return 'identity';
  const weights = new Map<string, number>();
  for (const item of header.split(',')) {
    const [name, ...parameters] = item.trim().toLowerCase().split(';');
    const quality = parameters.map(parameter => parameter.trim()).find(parameter => parameter.startsWith('q='));
    const raw = quality?.slice(2).trim();
    const weight = raw === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    weights.set(name!.trim(), weight);
  }
  let selected: TraceEncoding | null = null;
  let best = 0;
  for (const encoding of ['br', 'gzip', 'identity'] as const) {
    // Implicit identity is the fallback, not a preference over compression.
    const weight = weights.get(encoding) ?? (encoding === 'identity' ? 0 : weights.get('*') ?? 0);
    if (weight > best) { selected = encoding; best = weight; }
  }
  if (selected) return selected;
  return (weights.get('identity') ?? (weights.get('*') === 0 ? 0 : 1)) > 0 ? 'identity' : null;
}

/** Compress only authorised trace responses, retaining pipeline backpressure and cleanup. */
export async function sendTraceResponse(
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer | string | AsyncIterable<Buffer | string>,
): Promise<void> {
  const encoding = traceEncoding(req.headers['accept-encoding']);
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('Cache-Control', 'no-store');
  if (encoding === null) { res.writeHead(406); res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const source = Readable.from(typeof body === 'string' || Buffer.isBuffer(body) ? [body] : body);
  if (encoding === 'identity') {
    await pipeline(source, res);
    return;
  }
  res.setHeader('Content-Encoding', encoding);
  const compressor = encoding === 'br'
    ? createBrotliCompress({ params: { [constants.BROTLI_PARAM_QUALITY]: 4 } })
    : createGzip({ level: 6 });
  await pipeline(source, compressor, res);
}
