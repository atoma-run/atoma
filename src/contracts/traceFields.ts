/**
 * Projecting a control-plane decision out of a run trace of any size.
 *
 * A run trace is written by trusted host code (`TraceRecorder.persist`) into a
 * path the control plane itself constructed, and its SIZE is a function of how
 * much work the run did — measured 2026-08-23 over nine real traces:
 * `bytes ~= 107_457 + 18_964 x toolEvents`. A whole-file `JSON.parse` behind a
 * fixed byte cap therefore bounds AMBITION, not risk: project run `2857a579`
 * delivered its work, wrote a 781_071-byte trace, and was recorded `failed`
 * with `control-plane JSON is not a bounded regular file` because the cap was
 * 524_288. That is the defect this module exists to remove.
 *
 * The bound moves from the file to the projection. This reader enumerates the
 * document's DEPTH-1 members in bytes, reports the JSON shape of the members
 * it was asked to shape, and copies bytes only for the members it was asked to
 * value. For the coordinator's spec that is under 400 bytes captured from a
 * trace of any size, and ZERO model-authored bytes parsed: `result` and
 * `error` — the two members whose content a model wrote — are reported as
 * shapes and never materialised. `result.output` is typed `unknown` and capped
 * nowhere (`runner.ts` passes it straight through), so any design that
 * captured it would have rebuilt the same erasure bug at a larger threshold.
 *
 * Three properties make it safe to read a large file this way:
 *
 * - It is FAIL-CLOSED. A member is reported absent only after the scan reaches
 *   the closing `}` and then EOF. A truncated document can never read as
 *   "no `error` member", which is what rules out the cheaper head+tail byte
 *   window: that window cannot distinguish "the key is not there" from "my
 *   window was too small".
 * - It never decodes text to find structure. Every JSON structural byte is
 *   ASCII and every UTF-8 continuation byte is >= 0x80, so a chunk boundary
 *   cannot split a token and the byte-versus-UTF-16-code-unit confusion that
 *   overstated a hand measurement of this same file by 40x is not expressible
 *   here.
 * - Its memory is O(1) in the file: one reused chunk buffer, a key sink, and a
 *   value sink, each bounded by `TraceReadLimits`, with the file ceiling
 *   enforced on the bytes actually READ rather than on a `stat` that is stale
 *   the moment it returns.
 *
 * Deliberate laxness, declared: the document is validated at depth 1 only.
 * Inside a skipped container the scan tracks strings (so a brace in model prose
 * is never structural) and nesting depth, but does not check that brackets
 * match or that primitives are well-formed. `TraceRecorder` emits one
 * `JSON.stringify` per persist, so a document malformed only below depth 1 is
 * unreachable from the writer; and the direction of any such error is "accept a
 * document `JSON.parse` would reject", never "misread one of the projected
 * members", because those are still scanned exactly.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/** Maximum materialized JSON selection; streaming scans are independent of file size. */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;

/** Every refusal this reader can raise, so callers and tests name one string. */
export const TRACE_READ_ERRORS = {
  absent: 'run trace was never written',
  notRegular: 'run trace is not a bounded regular file',
  overCeiling: 'run trace exceeds the control-plane scan ceiling',
  notObject: 'run trace is not a JSON object',
  truncated: 'run trace is truncated or has trailing bytes',
  malformed: 'run trace is not well-formed JSON',
  overCapture: 'run trace field is longer than the control-plane capture budget',
} as const;

/**
 * Thrown for every refusal. Distinct from a caller's own predicate failures so
 * "I could not read the trace" is never confused with "I read it and it says
 * the run failed".
 *
 * NO MESSAGE CARRIES A FILESYSTEM PATH. `project_runs.error` is served to
 * tenants, and the row this module replaces leaked an absolute host path
 * (`/Users/…/.atoma/orgs/…`) into it.
 */
export class TraceFieldReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceFieldReadError';
  }
}

export type JsonShape = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface TraceFieldSpec {
  /**
   * Members whose VALUE the caller needs. Only primitives are captured; a
   * member listed here that holds an object or array is reported as a shape
   * and its value stays absent, so a caller's `typeof … === 'string'` test
   * refuses it.
   */
  readonly values: readonly string[];
  /** Members whose PRESENCE and JSON shape the caller needs, never content. */
  readonly shapes: readonly string[];
}

export interface TraceFields {
  /** Captured primitives, keyed by member name. Absent means "not captured". */
  readonly values: Readonly<Record<string, unknown>>;
  /** Shapes for every member named in either half of the spec. */
  readonly shapes: Readonly<Record<string, JsonShape>>;
}

export interface TraceReadLimits {
  /** Read granularity. Also the reader's whole steady-state footprint. */
  readonly chunkBytes: number;
  /** A member name longer than this cannot match a wanted name. */
  readonly maxKeyBytes: number;
  /** Per-member capture ceiling, including a string's own quotes. */
  readonly maxValueBytes: number;
  /** Total captured across all members. */
  readonly maxCaptureBytes: number;
  /** File ceiling, enforced on bytes read, not on a stat. */
  readonly maxFileBytes: number;
}

export const DEFAULT_TRACE_READ_LIMITS: TraceReadLimits = {
  chunkBytes: 64 * 1024,
  maxKeyBytes: 256,
  maxValueBytes: 512,
  maxCaptureBytes: 2_048,
  maxFileBytes: Number.MAX_SAFE_INTEGER,
};

const EOF = -1;

const BYTE = {
  tab: 0x09,
  lf: 0x0a,
  cr: 0x0d,
  space: 0x20,
  quote: 0x22,
  comma: 0x2c,
  minus: 0x2d,
  zero: 0x30,
  nine: 0x39,
  colon: 0x3a,
  bracketOpen: 0x5b,
  backslash: 0x5c,
  bracketClose: 0x5d,
  f: 0x66,
  n: 0x6e,
  t: 0x74,
  braceOpen: 0x7b,
  braceClose: 0x7d,
} as const;

/** JSON's number grammar, applied to depth-1 numbers so `01` is refused. */
const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

interface Scan {
  readonly fd: number;
  readonly buf: Buffer;
  readonly limits: TraceReadLimits;
  len: number;
  pos: number;
  /** Bytes read from the file so far — the ceiling is enforced on this. */
  read: number;
  eof: boolean;
}

function refuse(message: string): never {
  throw new TraceFieldReadError(message);
}

/** Current byte without consuming it, refilling the chunk when exhausted. */
function peek(s: Scan): number {
  if (s.pos < s.len) return s.buf[s.pos]!;
  if (s.eof) return EOF;
  const read = readSync(s.fd, s.buf, 0, s.buf.length, null);
  if (read === 0) {
    s.eof = true;
    s.len = 0;
    s.pos = 0;
    return EOF;
  }
  s.len = read;
  s.pos = 0;
  s.read += read;
  // The two stat checks in the entry point are stale the moment they return —
  // the child owns this directory and can still be appending. The ceiling that
  // matters is the one on bytes actually read.
  if (s.read > s.limits.maxFileBytes) refuse(TRACE_READ_ERRORS.overCeiling);
  return s.buf[0]!;
}

function take(s: Scan): number {
  const byte = peek(s);
  if (byte !== EOF) s.pos += 1;
  return byte;
}

function isWhitespace(byte: number): boolean {
  return byte === BYTE.space || byte === BYTE.tab || byte === BYTE.lf || byte === BYTE.cr;
}

/** Consume whitespace and return the next significant byte, unconsumed. */
function skipWhitespace(s: Scan): number {
  let byte = peek(s);
  while (byte !== EOF && isWhitespace(byte)) {
    s.pos += 1;
    byte = peek(s);
  }
  return byte;
}

/**
 * Consume one JSON string, including both quotes. Caller guarantees the
 * opening quote is next. With a sink, the raw bytes are appended and the
 * return value says whether the sink overflowed; the string is consumed either
 * way, so an unwanted 4MB string costs no memory at all.
 *
 * A backslash consumes exactly one following byte, which is sufficient for
 * termination: the four hex digits of a `\uXXXX` escape cannot themselves be a
 * quote or a backslash.
 */
function scanString(s: Scan, sink: number[] | null, maxBytes: number): boolean {
  let overflowed = false;
  const push = (byte: number): void => {
    if (sink === null) return;
    if (sink.length >= maxBytes) {
      overflowed = true;
      return;
    }
    sink.push(byte);
  };
  push(take(s));
  for (;;) {
    const byte = take(s);
    if (byte === EOF) refuse(TRACE_READ_ERRORS.truncated);
    push(byte);
    if (byte === BYTE.backslash) {
      const escaped = take(s);
      if (escaped === EOF) refuse(TRACE_READ_ERRORS.truncated);
      push(escaped);
      continue;
    }
    if (byte === BYTE.quote) return overflowed;
  }
}

/**
 * Consume one object or array, whatever it contains. Strings are scanned so a
 * `{` inside model prose is never counted as structure; depth is an integer,
 * not recursion, so a pathologically nested document cannot exhaust the stack.
 */
function skipContainer(s: Scan): void {
  let depth = 0;
  for (;;) {
    const byte = peek(s);
    if (byte === EOF) refuse(TRACE_READ_ERRORS.truncated);
    if (byte === BYTE.quote) {
      scanString(s, null, 0);
      continue;
    }
    s.pos += 1;
    if (byte === BYTE.braceOpen || byte === BYTE.bracketOpen) {
      depth += 1;
    } else if (byte === BYTE.braceClose || byte === BYTE.bracketClose) {
      depth -= 1;
      if (depth === 0) return;
    }
  }
}

/** Consume one number or literal token, up to its delimiter. */
function scanToken(s: Scan, sink: number[], maxBytes: number): void {
  for (;;) {
    const byte = peek(s);
    if (
      byte === EOF ||
      isWhitespace(byte) ||
      byte === BYTE.comma ||
      byte === BYTE.braceClose ||
      byte === BYTE.bracketClose
    ) {
      return;
    }
    if (sink.length >= maxBytes) refuse(TRACE_READ_ERRORS.overCapture);
    sink.push(byte);
    s.pos += 1;
  }
}

function shapeOf(byte: number): JsonShape | null {
  if (byte === BYTE.braceOpen) return 'object';
  if (byte === BYTE.bracketOpen) return 'array';
  if (byte === BYTE.quote) return 'string';
  if (byte === BYTE.t || byte === BYTE.f) return 'boolean';
  if (byte === BYTE.n) return 'null';
  if (byte === BYTE.minus || (byte >= BYTE.zero && byte <= BYTE.nine)) return 'number';
  return null;
}

/** Depth-1 numbers and literals are held to JSON's grammar, as `JSON.parse` is. */
function validateToken(sink: readonly number[], shape: JsonShape): void {
  const text = Buffer.from(sink).toString('latin1');
  if (shape === 'number') {
    if (!NUMBER_RE.test(text)) refuse(TRACE_READ_ERRORS.malformed);
    return;
  }
  if (shape === 'boolean') {
    if (text !== 'true' && text !== 'false') refuse(TRACE_READ_ERRORS.malformed);
    return;
  }
  if (text !== 'null') refuse(TRACE_READ_ERRORS.malformed);
}

function parseCaptured(sink: readonly number[]): unknown {
  try {
    return JSON.parse(Buffer.from(sink).toString('utf8')) as unknown;
  } catch {
    return refuse(TRACE_READ_ERRORS.malformed);
  }
}

function positiveInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`TraceReadLimits.${field} must be a positive integer`);
  }
  return value;
}

export interface TraceByteRange { readonly start: number; readonly end: number }

interface TraceRangeVisitor {
  member(name: string, range: TraceByteRange): void;
  events(ranges: TraceByteRange[] | null): void;
}

function position(s: Scan): number { return s.read - s.len + s.pos; }

function skipValue(s: Scan): void {
  const shape = shapeOf(skipWhitespace(s));
  if (shape === 'object' || shape === 'array') skipContainer(s);
  else if (shape === 'string') scanString(s, null, 0);
  else if (shape !== null) {
    const bytes: number[] = [];
    scanToken(s, bytes, s.limits.maxValueBytes);
    validateToken(bytes, shape);
  } else refuse(TRACE_READ_ERRORS.malformed);
}

function scanEvents(s: Scan): TraceByteRange[] {
  const ranges: TraceByteRange[] = [];
  s.pos += 1;
  if (skipWhitespace(s) === BYTE.bracketClose) { s.pos += 1; return ranges; }
  for (;;) {
    skipWhitespace(s);
    const start = position(s);
    skipValue(s);
    // Bound the offset index too, independently of payload bytes.
    if (ranges.length >= MAX_TRACE_BYTES / 64) refuse(TRACE_READ_ERRORS.overCapture);
    ranges.push({ start, end: position(s) });
    const separator = skipWhitespace(s);
    s.pos += 1;
    if (separator === BYTE.bracketClose) return ranges;
    if (separator === EOF) refuse(TRACE_READ_ERRORS.truncated);
    if (separator !== BYTE.comma) refuse(TRACE_READ_ERRORS.malformed);
  }
}

function scanTopLevel(fd: number, spec: TraceFieldSpec, limits: TraceReadLimits, visitor?: TraceRangeVisitor): TraceFields {
  const wantValue = new Set(spec.values);
  const wantShape = new Set([...spec.values, ...spec.shapes]);
  // Null prototype, not a literal: a `__proto__` member of the document must
  // become an own property, exactly as `JSON.parse` makes it, instead of
  // reaching `Object.prototype`'s setter.
  const values = Object.create(null) as Record<string, unknown>;
  const shapes = Object.create(null) as Record<string, JsonShape>;
  let captured = 0;

  const s: Scan = {
    fd,
    buf: Buffer.allocUnsafe(limits.chunkBytes),
    limits,
    len: 0,
    pos: 0,
    read: 0,
    eof: false,
  };

  if (skipWhitespace(s) !== BYTE.braceOpen) refuse(TRACE_READ_ERRORS.notObject);
  s.pos += 1;

  if (skipWhitespace(s) === BYTE.braceClose) {
    s.pos += 1;
  } else {
    for (;;) {
      const keyStart = skipWhitespace(s);
      if (keyStart === EOF) refuse(TRACE_READ_ERRORS.truncated);
      if (keyStart !== BYTE.quote) refuse(TRACE_READ_ERRORS.malformed);
      const keyBytes: number[] = [];
      const keyOverflowed = scanString(s, keyBytes, limits.maxKeyBytes);
      // An overflowed name cannot match a wanted one, so it needs no decode —
      // and must not be decoded, since the cut may land mid-codepoint.
      let name: string | null = null;
      if (!keyOverflowed) {
        const parsed = parseCaptured(keyBytes);
        name = typeof parsed === 'string' ? parsed : refuse(TRACE_READ_ERRORS.malformed);
      }

      if (skipWhitespace(s) !== BYTE.colon) refuse(TRACE_READ_ERRORS.malformed);
      s.pos += 1;

      const valueStart = skipWhitespace(s);
      if (valueStart === EOF) refuse(TRACE_READ_ERRORS.truncated);
      const shape = shapeOf(valueStart);
      if (shape === null) refuse(TRACE_READ_ERRORS.malformed);

      const start = position(s);
      const takeValue = name !== null && wantValue.has(name);
      let valueBytes: number[] | null = null;
      if (visitor && name === 'events' && shape === 'array') {
        visitor.events(scanEvents(s));
      } else if (shape === 'object' || shape === 'array') {
        skipContainer(s);
      } else if (shape === 'string') {
        if (takeValue) {
          valueBytes = [];
          if (scanString(s, valueBytes, limits.maxValueBytes)) {
            refuse(TRACE_READ_ERRORS.overCapture);
          }
        } else {
          scanString(s, null, 0);
        }
      } else {
        valueBytes = [];
        scanToken(s, valueBytes, limits.maxValueBytes);
        validateToken(valueBytes, shape);
        if (!takeValue) valueBytes = null;
      }

      if (name !== null) {
        visitor?.member(name, { start, end: position(s) });
        if (name === 'events' && shape !== 'array') visitor?.events(null);
        if (wantShape.has(name)) shapes[name] = shape;
        if (takeValue) {
          if (valueBytes === null) {
            // A duplicate member whose later occurrence is a container: last
            // wins for the shape, and the earlier captured value is dropped.
            delete values[name];
          } else {
            captured += valueBytes.length;
            if (captured > limits.maxCaptureBytes) refuse(TRACE_READ_ERRORS.overCapture);
            values[name] = parseCaptured(valueBytes);
          }
        }
      }

      const separator = skipWhitespace(s);
      if (separator === BYTE.comma) {
        s.pos += 1;
        continue;
      }
      if (separator === BYTE.braceClose) {
        s.pos += 1;
        break;
      }
      if (separator === EOF) refuse(TRACE_READ_ERRORS.truncated);
      refuse(TRACE_READ_ERRORS.malformed);
    }
  }

  // The whole point: absence is only reportable once the document is known to
  // have ended here.
  if (skipWhitespace(s) !== EOF) refuse(TRACE_READ_ERRORS.truncated);
  return { values, shapes };
}

/**
 * Read the depth-1 members named by `spec` from the JSON document at
 * `pathname`, in memory bounded by `limits` regardless of file size.
 *
 * Throws `TraceFieldReadError` for an absent, irregular, oversized, malformed
 * or truncated document. Never throws for a member that is simply not there:
 * that is reported as absence, and only after the document is proven complete.
 */
export function readTraceTopLevelFields(
  pathname: string,
  spec: TraceFieldSpec,
  limits: Partial<TraceReadLimits> = {}
): TraceFields {
  const resolved: TraceReadLimits = { ...DEFAULT_TRACE_READ_LIMITS, ...limits };
  positiveInt(resolved.chunkBytes, 'chunkBytes');
  positiveInt(resolved.maxKeyBytes, 'maxKeyBytes');
  positiveInt(resolved.maxValueBytes, 'maxValueBytes');
  positiveInt(resolved.maxCaptureBytes, 'maxCaptureBytes');
  positiveInt(resolved.maxFileBytes, 'maxFileBytes');

  // `lstat` FIRST, before any open: `openSync` on a FIFO blocks forever, and a
  // Vitest timeout cannot interrupt a synchronous block.
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      refuse(TRACE_READ_ERRORS.absent);
    }
    refuse(TRACE_READ_ERRORS.notRegular);
  }
  // An `lstat` of a symlink reports the LINK, which is not a file — so this one
  // test holds symlink refusal, and a separate `isSymbolicLink()` branch after
  // it would be unreachable.
  if (!stat.isFile()) refuse(TRACE_READ_ERRORS.notRegular);
  if (stat.size > resolved.maxFileBytes) refuse(TRACE_READ_ERRORS.overCeiling);

  return withTraceFile(pathname, resolved.maxFileBytes, fd => scanTopLevel(fd, spec, resolved));
}

function withTraceFile<T>(pathname: string, maxFileBytes: number, read: (fd: number) => T): T {
  const fd = openTraceFile(pathname, maxFileBytes);
  try { return read(fd); } finally { closeSync(fd); }
}

function openTraceFile(pathname: string, maxFileBytes: number): number {
  const stat = lstatSync(pathname);
  if (!stat.isFile()) refuse(TRACE_READ_ERRORS.notRegular);
  const optional = fsConstants as Partial<typeof fsConstants>;
  const flags = fsConstants.O_RDONLY | (optional.O_NOFOLLOW ?? 0) | (optional.O_NONBLOCK ?? 0);
  const fd = openSync(pathname, flags);
  try {
    // Re-check ON THE DESCRIPTOR. The child process owns this directory, so
    // between the `lstat` above and this open the path can have been replaced;
    // the old whole-file reader left exactly that window open.
    const opened = fstatSync(fd);
    if (!opened.isFile()) refuse(TRACE_READ_ERRORS.notRegular);
    if (opened.size > maxFileBytes) refuse(TRACE_READ_ERRORS.overCeiling);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/**
 * Index and read one immutable recorder snapshot. All ranges and subsequent
 * reads share an fd, so an atomic persist cannot mix two generations.
 * The callback is synchronous: callers must finish reading before it returns.
 */
export function withTraceDocument<T>(pathname: string, use: (document: TraceDocument) => T): T {
  return withTraceFile(pathname, Number.MAX_SAFE_INTEGER, fd => {
    const { fields, events } = indexTraceDocument(fd);
    return use({ fields, events, read: range => readTraceRange(fd, range) });
  });
}

export interface TraceDocument {
  readonly fields: ReadonlyMap<string, TraceByteRange>;
  readonly events: readonly TraceByteRange[] | null;
  read(range: TraceByteRange): unknown;
}

function readTraceRange(fd: number, range: TraceByteRange): unknown {
  const size = range.end - range.start;
  if (size > MAX_TRACE_BYTES) refuse(TRACE_READ_ERRORS.overCapture);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, range.start + offset);
    if (!count) refuse(TRACE_READ_ERRORS.truncated);
    offset += count;
  }
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { return refuse(TRACE_READ_ERRORS.malformed); }
}

/** Bounded projection, reading one member/event at a time instead of the file. */
export function projectTraceDocument(
  pathname: string,
  member: (name: string, read: () => unknown) => unknown,
  event: (read: () => unknown, index: number) => unknown,
): { run: Record<string, unknown>; totalEvents: number } {
  return withTraceDocument(pathname, document => {
    const run: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    let captured = 0;
    const budget = (value: unknown): unknown => {
      if (value !== undefined) captured += Buffer.byteLength(JSON.stringify(value));
      if (captured > MAX_TRACE_BYTES) refuse(TRACE_READ_ERRORS.overCapture);
      return value;
    };
    for (const [name, range] of document.fields) {
      if (name !== 'events') {
        const value = budget(member(name, () => document.read(range)));
        if (value !== undefined) run[name] = value;
      }
    }
    if (document.events) {
      run['events'] = document.events.flatMap((range, index) => {
        const value = budget(event(() => document.read(range), index));
        return value === undefined ? [] : [value];
      });
    }
    return { run, totalEvents: document.events?.length ?? 0 };
  });
}

/** Stream complete or delta JSON with backpressure; never materialize payloads. */
export async function* traceDocumentChunks(pathname: string, after?: number): AsyncGenerator<Buffer | string> {
  const fd = openTraceFile(pathname, Number.MAX_SAFE_INTEGER);
  try {
    const chunks = function* (range: TraceByteRange): Generator<Buffer> {
      for (let offset = range.start; offset < range.end;) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, range.end - offset));
        const count = readSync(fd, buffer, 0, buffer.length, offset);
        if (!count) refuse(TRACE_READ_ERRORS.truncated);
        offset += count;
        yield buffer.subarray(0, count);
      }
    };
    if (after === undefined) {
      yield* chunks({ start: 0, end: fstatSync(fd).size });
      return;
    }
    const { fields, events } = indexTraceDocument(fd);
    if (events === null) {
      yield* chunks({ start: 0, end: fstatSync(fd).size });
      return;
    }
    const ranges: TraceByteRange[] = events;
    const from = after <= ranges.length ? after : 0;
    yield '{';
    for (const [name, range] of fields) {
      if (name === 'events' || name === 'eventsFrom' || name === 'eventsTotal') continue;
      yield JSON.stringify(name) + ':';
      yield* chunks(range);
      yield ',';
    }
    yield '"events":[';
    for (let index = from; index < ranges.length; index += 1) {
      if (index > from) yield ',';
      yield* chunks(ranges[index]!);
    }
    yield `],"eventsFrom":${from},"eventsTotal":${ranges.length}}`;
  } finally { closeSync(fd); }
}

function indexTraceDocument(fd: number): { fields: Map<string, TraceByteRange>; events: TraceByteRange[] | null } {
  const fields = new Map<string, TraceByteRange>();
  let events: TraceByteRange[] | null = null;
  scanTopLevel(fd, { values: [], shapes: [] }, DEFAULT_TRACE_READ_LIMITS, {
    member(name, range) {
      if (fields.size >= 4096 && !fields.has(name)) refuse(TRACE_READ_ERRORS.overCapture);
      fields.set(name, range);
    },
    events(ranges) { events = ranges; },
  });
  return { fields, events };
}
