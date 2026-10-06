import type { VizEvent } from '../client/types.js';

export interface DiffCell {
  text: string;
  /** Line within the submitted excerpt, never an inferred file offset. */
  line: number;
  kind: 'context' | 'delete' | 'insert';
}

export interface DiffRow { before: DiffCell | null; after: DiffCell | null }

interface ActivityDiff {
  rows: DiffRow[];
  beforeAvailable: boolean;
  afterAvailable: boolean;
}

const diffCache = new WeakMap<VizEvent, { before: unknown; after: unknown; diff: ActivityDiff }>();

/** Unique common lines form monotonic anchors without a file-size-squared matrix. */
function commonAnchors(left: string[], right: string[]): [number, number][] {
  const positions = (lines: string[]) => {
    const map = new Map<string, number>();
    lines.forEach((line, index) => map.set(line, map.has(line) ? -1 : index));
    return map;
  };
  const a = positions(left);
  const b = positions(right);
  const pairs: [number, number][] = [];
  for (const [line, i] of a) {
    const j = b.get(line);
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
  }
  const tails: number[] = [];
  const previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, index) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pairs[tails[mid]!]![1] < pair[1]) low = mid + 1;
      else high = mid;
    }
    if (low > 0) previous[index] = tails[low - 1]!;
    tails[low] = index;
  });
  const anchors: [number, number][] = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]!) anchors.push(pairs[index]!);
  return anchors.reverse();
}

/** Full recorded text; alignment work is bounded, content is never shortened. */
export function buildActivityDiff(event: VizEvent): ActivityDiff {
  const before = event.name === 'edit_file' ? event.args?.['old_string'] : undefined;
  const after = event.args?.[event.name === 'edit_file' ? 'new_string' : 'content'];
  const cached = diffCache.get(event);
  if (cached && cached.before === before && cached.after === after) return cached.diff;
  const beforeAvailable = typeof before === 'string';
  const afterAvailable = typeof after === 'string';
  const left = beforeAvailable && before !== '' ? before.split('\n') : [];
  const right = afterAvailable && after !== '' ? after.split('\n') : [];
  const rows: DiffRow[] = [];
  const cell = (lines: string[], index: number, kind: DiffCell['kind']): DiffCell =>
    ({ text: lines[index]!, line: index + 1, kind });
  const context = (i: number, j: number) => rows.push({
    before: cell(left, i, 'context'), after: cell(right, j, 'context'),
  });
  const block = (i: number, endI: number, j: number, endJ: number, known = true) => {
    while (i < endI || j < endJ) rows.push({
      before: i < endI ? cell(left, i++, known ? 'delete' : 'context') : null,
      after: j < endJ ? cell(right, j++, known ? 'insert' : 'context') : null,
    });
  };
  const gap = (startI: number, endI: number, startJ: number, endJ: number) => {
    let i = startI;
    let j = startJ;
    while (i < endI && j < endJ && left[i] === right[j]) context(i++, j++);
    let suffix = 0;
    while (i < endI && j < endJ && left[endI - 1] === right[endJ - 1]) {
      endI--; endJ--; suffix++;
    }
    const n = endI - i;
    const m = endJ - j;
    if (n && m && (n + 1) * (m + 1) <= 250_000) {
      // Exact alignment within small gaps, including repeated context lines.
      const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
      for (let a = n - 1; a >= 0; a--) for (let b = m - 1; b >= 0; b--) {
        lcs[a]![b] = left[i + a] === right[j + b] ? 1 + lcs[a + 1]![b + 1]!
          : Math.max(lcs[a + 1]![b]!, lcs[a]![b + 1]!);
      }
      let a = 0;
      let b = 0;
      let pendingI = i;
      let pendingJ = j;
      while (a < n || b < m) {
        if (a < n && b < m && left[i + a] === right[j + b]) {
          block(pendingI, i + a, pendingJ, j + b);
          context(i + a++, j + b++);
          pendingI = i + a;
          pendingJ = j + b;
        } else if (b === m || (a < n && lcs[a + 1]![b]! >= lcs[a]![b + 1]!)) a++;
        else b++;
      }
      block(pendingI, endI, pendingJ, endJ);
    } else block(i, endI, j, endJ);
    for (let k = 0; k < suffix; k++) context(endI + k, endJ + k);
  };
  // An overwrite does not reveal prior content. Never invent removed lines.
  if (!beforeAvailable || !afterAvailable) block(0, left.length, 0, right.length, false);
  else {
    let i = 0;
    let j = 0;
    for (const [a, b] of commonAnchors(left, right)) {
      gap(i, a, j, b);
      context(a, b);
      i = a + 1;
      j = b + 1;
    }
    gap(i, left.length, j, right.length);
  }
  const diff = { rows, beforeAvailable, afterAvailable };
  diffCache.set(event, { before, after, diff });
  return diff;
}

/** Preserve code and indentation, expanding tab stops; never ellipsise a line. */
export function wrapDiffLine(text: string, width: number, measure: (value: string) => number): string[] {
  let expanded = '';
  let column = 0;
  for (const character of text) {
    const value = character === '\t' ? ' '.repeat(4 - column % 4) : character;
    expanded += value;
    column += value.length;
  }
  const characters = Array.from(expanded);
  const lines: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let low = 1;
    // Probe near the visible width, not half of a potentially megabyte line.
    const remaining = characters.length - start;
    let high = 1;
    while (high < remaining && measure(characters.slice(start, start + high).join('')) <= width) {
      low = high;
      high = Math.min(remaining, high * 2);
    }
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (measure(characters.slice(start, start + mid).join('')) <= width) low = mid;
      else high = mid - 1;
    }
    lines.push(characters.slice(start, start + low).join(''));
    start += low;
  }
  return lines.length ? lines : [''];
}
