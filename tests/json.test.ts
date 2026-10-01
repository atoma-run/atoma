import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  extractJson,
  extractJsonEx,
  findAllJsonObjects,
  parsePayloadTolerant,
  parseTwoJson,
  parseVerdict,
  parsePlanTolerant,
  parsePlanWithFallback,
  parseWith,
  repairTruncatedJson,
  repairPrematureClose,
  resultPayloadSchema,
  salvageNestedSummary,
  salvageResultEnvelope,
  verdictSchema,
  isEffectivelyEmptyMods,
} from '../src/atoms/json.js';

describe('extractJson', () => {
  it('parses a plain JSON object', () => {
    expect(extractJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('parses JSON inside a ```json fenced block', () => {
    const text = 'Here you go:\n```json\n{"a":1}\n```\nthanks';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  it('extracts an object surrounded by prose', () => {
    const text = 'preamble {"k":"v"} postamble';
    expect(extractJson(text)).toEqual({ k: 'v' });
  });

  it('repairs a response truncated inside a string value', () => {
    const truncated = '{"output":"this got cut off in the middle of a stri';
    const parsed = extractJson(truncated) as { output: string };
    expect(parsed.output.startsWith('this got cut off')).toBe(true);
  });

  it('repairs a response truncated inside a nested object', () => {
    const truncated = '{"a":1,"b":{"c":"x","d":"y';
    const parsed = extractJson(truncated) as { a: number; b: { c: string; d: string } };
    expect(parsed.a).toBe(1);
    expect(parsed.b.c).toBe('x');
    expect(parsed.b.d.startsWith('y')).toBe(true);
  });

  it('repairs a truncated array of objects', () => {
    const truncated = '[{"id":1},{"id":2},{"id":3,"name":"partia';
    const parsed = extractJson(truncated) as Array<{ id: number; name?: string }>;
    expect(parsed.length).toBe(3);
    expect(parsed[2]?.id).toBe(3);
  });

  it('throws a useful ValidationError when there is no JSON at all', () => {
    expect(() => extractJson('no json here, sorry')).toThrow(/no JSON found/);
  });
});

/**
 * Regression suite for the NESTED-FENCE evidence-destruction bug.
 *
 * The fence regex is non-greedy, so it stops at the first closing ``` — and
 * an L1 obeying the GROUND-TRUTH evidence contract pastes shell output into
 * `summary`, which routinely contains a nested ```bash block. The capture
 * then ended mid-string, `repairTruncatedJson` closed it into something
 * schema-VALID BUT AMPUTATED, and `parseWith` returned that lossy object
 * without ever reaching the candidate scan that would have recovered the
 * intact payload.
 *
 * Measured on run 2026-07-25T22-10-42: a 162-char summary reached the
 * validator as 39 chars with the `## Usage` proof gone; the validator
 * (correctly) rejected it as "cut off mid-sentence", costing a full extra
 * supervise cycle. The same bug silently truncated a phase-1 summary from
 * 2620 recoverable chars to 308, so the next phase ran blind.
 */
describe('nested ``` fence inside a JSON string (evidence-destruction regression)', () => {
  const summary =
    'Documented rev-cli.\n== GROUND TRUTH ==\n```bash\n$ node index.js racecar\nReversed: racecar\nPalindrome: yes\n```\n## Usage section present with 3 verified invocations.';
  const envelope = { output: 'README.md written', summary };
  const fenced = '```json\n' + JSON.stringify(envelope) + '\n```';

  it('extractJson recovers the FULL payload despite the nested fence', () => {
    expect(extractJson(fenced)).toEqual(envelope);
  });

  it('recovers it WITHOUT resorting to a lossy repair', () => {
    const out = extractJsonEx(fenced);
    expect(out.repaired).toBe(false);
    expect((out.value as typeof envelope).summary).toBe(summary);
  });

  it('parsePayloadTolerant preserves the whole evidence block (162 chars, not 39)', () => {
    const parsed = parsePayloadTolerant(fenced);
    expect(String(parsed.summary)).toBe(summary);
    expect(String(parsed.summary)).toContain('## Usage');
    expect(String(parsed.summary).length).toBe(summary.length);
  });

  it('parseWith keeps the intact payload for the result schema', () => {
    const parsed = parseWith(resultPayloadSchema, fenced);
    expect(parsed.summary).toBe(summary);
  });

  it('survives MULTIPLE nested fences in the same string', () => {
    const multi = {
      output: 'ok',
      summary: 'a\n```bash\nx\n```\nb\n```json\n{"not":"the payload"}\n```\nc',
    };
    expect(extractJson('```json\n' + JSON.stringify(multi) + '\n```')).toEqual(multi);
  });

  it('parseTwoJson survives a nested fence in the first payload', () => {
    const strategy = { strategy: 'reuse', target: 'Ammonia', reasoning: 'run: ```bash\nls\n```' };
    const plan = { reasoning: 'r', subtasks: [{ description: 'd' }] };
    const text =
      '```json\n' + JSON.stringify(strategy) + '\n```\n```json\n' + JSON.stringify(plan) + '\n```';
    const [a, b] = parseTwoJson(text);
    expect(a).toEqual(strategy);
    expect(b).toEqual(plan);
  });

  it('parseTwoJson splits a FUSED one-element strategy+plan array (live Opus emission)', () => {
    // Observed 2026-08-08 (app-guest-counter): Opus answered the two-payload
    // request with a VALID one-element array whose single object carried both
    // the strategy discriminators AND the plan fields — a complete, correct
    // response that crashed the parse as "missing second JSON".
    const fused = [
      {
        strategy: 'reuse',
        target: 'Leukocyte',
        reasoning: 'coupled artefacts, sequential build',
        subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }],
        aggregation: { mode: 'sequential' },
        expectedOutput: 'a working guestbook app',
      },
    ];
    const [a, b] = parseTwoJson(JSON.stringify(fused));
    expect(a).toEqual({ strategy: 'reuse', target: 'Leukocyte', reasoning: 'coupled artefacts, sequential build' });
    expect(b).toEqual({
      reasoning: 'coupled artefacts, sequential build',
      subtasks: [{ description: 'phase 1' }, { description: 'phase 2' }],
      aggregation: { mode: 'sequential' },
      expectedOutput: 'a working guestbook app',
    });
    // A strategy-only single element (no subtasks) is NOT split — the
    // truncation paths keep their placeholder semantics.
    const strategyOnly = JSON.stringify([{ strategy: 'reuse', target: 'X', reasoning: 'r' }]);
    expect(() => parseTwoJson(strategyOnly)).toThrow();
  });

  it('still honours a well-formed fence with no nesting (no behaviour change)', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonEx('```json\n{"a":1}\n```').repaired).toBe(false);
  });

  it('a genuinely truncated payload still parses via repair, and is flagged', () => {
    // No closing fence at all — the max_tokens cutoff case the repair exists for.
    const out = extractJsonEx('{"output":"x","summary":"unterminated');
    expect(out.repaired).toBe(true);
    expect((out.value as { output: string }).output).toBe('x');
  });

  it('does NOT hijack the "prefer the LAST candidate" semantics', () => {
    // Guard against the regression this fix nearly introduced: trying the
    // first BALANCED object up front made a short example envelope shown in
    // prose win over the real payload that follows. The balanced-object
    // recovery must therefore run only where the old code would have gone to
    // a lossy repair — never ahead of the slice path.
    const text =
      'Example of the shape: {"output":"e","summary":"s"} — and here is the real result:\n' +
      '{"output":"the real deliverable","summary":"the actual evidence block"}';
    const parsed = parseWith(resultPayloadSchema, text);
    expect(parsed.output).toBe('the real deliverable');
  });
});

/**
 * Run 8606cf38 (2026-09-30): the L1 pasted its validate_html outcome, itself
 * JSON, into `summary` without escaping its quotes, beside raw newlines. The
 * result became a non-JSON fallback, the `non-json-envelope` gate rejected a
 * fully verified execution, and it ran again for 372 s. With the newlines
 * escaped, jsonrepair instead cut the summary at the colon of `http:`.
 */
describe('a summary that pastes JSON evidence without escaping it (run 8606cf38)', () => {
  const smokeResult =
    '{"ok":true,"checks":{"longMode":true,"paused":true},"mode":"longBreak","display":"14:59"}';
  const summary = [
    'Long break mode added and validated with preserved timer controls.',
    '== GROUND TRUTH ==',
    'index.html (4314 bytes) — list_files: index.html',
    'served at http://localhost:33149/',
    'validate_html: ok=true, consoleErrors=0, failedRequests=0',
    `smoke: (() => { const t=window.__timer; return {ok:t.mode==='longBreak'}; })() -> ${smokeResult} `,
    'observed state: mode=longBreak, display=14:59, status=Paused.',
  ].join('\n');
  const output = {
    url: 'http://localhost:33149/',
    files: ['index.html'],
    probes: [{ probe: 'web', ok: true, smokeResult: JSON.parse(smokeResult) as unknown }],
  };
  // What the model emitted: a well-formed output, then the summary between
  // quotes with its newlines raw and its inner quotes bare.
  const emitted = `{"output":${JSON.stringify(output)},"summary":"${summary}"}`;

  it('recovers the whole summary and the output', () => {
    expect(() => JSON.parse(emitted)).toThrow();
    expect(parsePayloadTolerant(emitted)).toEqual({ output, summary });
  });

  it('keeps the summary whole where jsonrepair would cut it at `http:`', () => {
    const newlinesEscaped = `{"output":${JSON.stringify(output)},"summary":"${summary.replace(/\n/g, '\\n')}"}`;
    expect(parsePayloadTolerant(newlinesEscaped)).toEqual({ output, summary });
  });

  it('reads a fenced envelope the same way', () => {
    expect(parsePayloadTolerant('```json\n' + emitted + '\n```')).toEqual({ output, summary });
  });

  it('decodes the escapes around the paste and keeps the paste verbatim', () => {
    // No raw control character: the model escaped what it wrote itself.
    const body = 'path C:\\work, escaped \\"x\\", newline\\nend -> {"text":"a\\nb"}';
    expect(parsePayloadTolerant(`{"output":"README.md","summary":"${body}"}`)).toEqual({
      output: 'README.md',
      summary: 'path C:\\work, escaped "x", newline\nend -> {"text":"a\\nb"}',
    });
  });

  it('keeps every backslash of a body that escaped nothing', () => {
    // Raw newlines say the model escaped nothing, so `\n` in a path is not one.
    const body = `built C:\\Users\\mgf\\new\\build\\files\\temp\nsmoke -> ${smokeResult}`;
    expect(parsePayloadTolerant(`{"output":"ok","summary":"${body}"}`)).toEqual({ output: 'ok', summary: body });
  });

  it('escapes raw control characters inside the output strings', () => {
    const text = `{"output":{"smoke":"line one\nline two"},"summary":"${summary}"}`;
    expect(parsePayloadTolerant(text)).toEqual({
      output: { smoke: 'line one\nline two' },
      summary,
    });
  });

  it('leaves an envelope that parses losslessly to the strict path', () => {
    const wellFormed = JSON.stringify({ output, summary });
    expect(salvageResultEnvelope(wellFormed)).toBeNull();
    expect(parsePayloadTolerant(wellFormed)).toEqual({ output, summary });
    // Raw newlines alone are a lossless repair, whatever follows the summary.
    const rawNewlines = '{"output":1,"summary":"clean\nsummary","note":"n"}';
    expect(salvageResultEnvelope(rawNewlines)).toBeNull();
    expect(parsePayloadTolerant(rawNewlines)).toEqual({ output: 1, summary: 'clean\nsummary' });
  });

  it('never fuses two envelopes, or an envelope and what follows it', () => {
    // Each of these read as ONE summary, or the first envelope's output, when
    // the last `"}` of the response was taken for the summary's end.
    const last = { output: 'final', summary: 'the final evidence' };
    const twoWellFormed = `${JSON.stringify({ output: 'draft', summary: 'first attempt' })}\n${JSON.stringify(last)}`;
    expect(salvageResultEnvelope(twoWellFormed)).toBeNull();
    expect(parsePayloadTolerant(twoWellFormed)).toEqual(last);
    for (const text of [
      `{"output":"draft","summary":"first -> {"ok":true,"checks":{"title":"ok"}}"}\n{"output":"final","summary":"second -> {"ok":true}"}`,
      '{"output":"a","summary":"line1\nline2"}\n{"note":"x"}',
      '{"output":"a","summary":"line1\nline2 -> {"ok":true}"}\n```json\n{"note":"x"}\n```',
      '```json\n{"output": 1, "summary": "the word "quoted" here"}\n```\n```json\n{"output": 2, "summary": "second"}\n```',
      `{"output":1,"summary":"${summary}","note":"n"}`,
    ]) {
      expect(salvageResultEnvelope(text)).toBeNull();
    }
  });

  it('does not take a cut inside the paste for the end of the envelope', () => {
    // Nothing in the text says the response was cut; the paste that never
    // closes, or closes on the response's last quote, does.
    expect(salvageResultEnvelope('{"output": "see below", "summary": "I could not finish. Config: {"mode":"fast"}')).toBeNull();
    const cut = `{"output":{"url":"u"},"summary":"validated\nsmoke -> {"ok":true,"display":"14:59"}`;
    expect(salvageResultEnvelope(cut)).toBeNull();
  });

  it('does not guess where the envelope is ambiguous', () => {
    // Prose before the envelope, a summary-first envelope, text after it and
    // a key between output and summary all keep the reading they had before.
    expect(salvageResultEnvelope(`Here is the result:\n${emitted}`)).toBeNull();
    expect(salvageResultEnvelope(`{"summary":"${summary}","output":${JSON.stringify(output)}}`)).toBeNull();
    expect(salvageResultEnvelope(`${emitted}\nLet me know if you need more.`)).toBeNull();
    expect(
      salvageResultEnvelope(`{"output":${JSON.stringify(output)},"notes":"n","summary":"${summary}"}`)
    ).toBeNull();
    // A bare quote in the prose itself, outside anything pasted.
    expect(salvageResultEnvelope('{"output":1,"summary":"the "quoted"\nword -> {"ok":true}"}')).toBeNull();
  });
});

/**
 * Run 3cbef119 (2026-10-01): the web molecule wrote its summary inside
 * `output` and closed one brace short. Every check had passed; the result
 * became a non-JSON fallback and a second execution re-ran them all, 389 s.
 */
describe('a summary written inside output, one brace short (run 3cbef119)', () => {
  const output = {
    url: 'http://localhost:42827/',
    files: ['index.html'],
    probes: [{ probe: 'web', ok: true, smokeResult: { ok: true, checks: { runningBefore: true, inputSuppressed: true } } }],
  };
  const summary = [
    'Focus Timer keyboard regression checks passed.',
    '== GROUND TRUTH ==',
    "smoke: (() => { return {ok:true}; })() -> {ok:true,status:'Paused'}",
    "observed: hint contains 'P pause'.",
  ].join('\n');
  // The output's members, its closing brace left out: the summary goes in there.
  const members = JSON.stringify(output).slice(0, -1);
  const emitted = `{"output":${members},"summary":${JSON.stringify(summary)}}`;

  it('lifts the summary out and keeps the rest as the output', () => {
    expect(() => JSON.parse(emitted)).toThrow();
    expect(parsePayloadTolerant(emitted)).toEqual({ output, summary });
  });

  it('reads it fenced, or with raw newlines in its strings, the same way', () => {
    expect(parsePayloadTolerant('```json\n' + emitted + '\n```')).toEqual({ output, summary });
    // The summary pasted between quotes as it is, its newlines raw.
    expect(parsePayloadTolerant(`{"output":${members},"summary":"${summary}"}`)).toEqual({ output, summary });
  });

  it('reads the response the web molecule sent', () => {
    const real = readFileSync(new URL('./fixtures/nested-summary-3cbef119.txt', import.meta.url), 'utf8');
    expect(() => JSON.parse(real)).toThrow();
    const read = parsePayloadTolerant(real);
    expect(read.summary).toMatch(/^Focus Timer keyboard regression checks passed\.\n== GROUND TRUTH ==/);
    expect(read.summary).toMatch(/hint contains 'P pause'\.$/);
    expect(Object.keys(read.output as object)).toEqual(['url', 'files', 'probes']);
  });

  it('accepts what it cannot tell from the slip: a cut right after an output ending in its own summary', () => {
    // Recorded, not endorsed: a data member named `summary` becomes the
    // evidence summary when the response stops exactly there.
    expect(salvageNestedSummary('{"output":{"title":"Q3","summary":"Revenue up 4%"}')).toEqual({
      output: { title: 'Q3' }, summary: 'Revenue up 4%',
    });
  });

  it('does not guess where the shape is anything else', () => {
    for (const text of [
      // Well formed, the summary nested on purpose: nothing is missing.
      `{"output":${members},"summary":"s"}}`,
      // Two members named summary, one of them the output's own.
      '{"output":{"url":"u","summary":"Revenue up 4%","summary":"Checks passed"}',
      // An integer-like key after the summary, which Object.keys lists first.
      '{"output":{"url":"u","summary":"s","404":"x"}',
      // Two outputs, or two envelopes.
      '{"output":{"draft":true},"output":{"url":"u","summary":"s"}',
      '{"output":{"a":1},"summary":"first"}\n{"output":{"url":"u","summary":"s"}',
      // A trailing comma.
      '{"output":{"url":"u","summary":"s",}',
      // Two braces short.
      '{"output":{"a":{"b":1,"summary":"s"}',
      // The summary is not the last member of output.
      '{"output":{"summary":"s","url":"u"}',
      // Prose before, or text after, the envelope.
      `Result: ${emitted}`,
      `${emitted}\nLet me know.`,
      // The output is not an object.
      '{"output":"x","summary":"s"',
      // The nested summary is not a string.
      '{"output":{"url":"u","summary":{"ok":true}}',
    ]) {
      expect(salvageNestedSummary(text)).toBeNull();
    }
    expect(parsePayloadTolerant(`${emitted}\nLet me know.`).summary).toMatch(/^fallback produced non-JSON output/);
  });
});

describe('repairTruncatedJson', () => {
  it('returns null when JSON is already balanced', () => {
    expect(repairTruncatedJson('{"a":1}')).toBeNull();
  });

  it('closes an unterminated string and one object', () => {
    expect(repairTruncatedJson('{"a":"hello')).toBe('{"a":"hello"}');
  });

  it('handles escaped quotes correctly', () => {
    const repaired = repairTruncatedJson('{"a":"he said \\"hi');
    expect(repaired).toBe('{"a":"he said \\"hi"}');
    expect(JSON.parse(repaired!)).toEqual({ a: 'he said "hi' });
  });

  it('strips a trailing comma when repairing', () => {
    expect(repairTruncatedJson('{"a":1,')).toBe('{"a":1}');
  });
});

describe('verdictSchema', () => {
  it('accepts an approved verdict', () => {
    expect(verdictSchema.safeParse({ approved: true, reasoning: 'ok' }).success).toBe(true);
  });

  it('accepts a rejected ephemeral verdict with empty modifications (pure retry)', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'transient flake',
      modifications: {},
      scope: 'ephemeral',
    });
    expect(res.success).toBe(true);
  });

  it('rejects a patch verdict with empty modifications', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'diagnostic only, no prescription',
      modifications: {},
      scope: 'patch',
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.issues.some((i) => i.path.includes('modifications'))).toBe(true);
    }
  });

  it('rejects a branch verdict with only nullish/empty fields in modifications', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'needs a variant',
      modifications: { addTools: [], removeTools: [], additionalContext: '' },
      scope: 'branch',
      branchName: 'NewThing',
    });
    expect(res.success).toBe(false);
  });

  it('accepts a patch verdict with at least one concrete field', () => {
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'tighten output discipline',
      modifications: { systemPromptAppend: 'Be concise.' },
      scope: 'patch',
    });
    expect(res.success).toBe(true);
  });

  it('strict verdictSchema still rejects a negative verdict missing scope', () => {
    // verdictSchema itself stays strict — tolerance lives in parseVerdict,
    // which is what runtime code calls. This test guards against anyone
    // accidentally weakening the schema and masking real bugs.
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'grid is wrong',
    });
    expect(res.success).toBe(false);
  });

  it('parseVerdict tolerates a Haiku response that omits scope + modifications', () => {
    // Exact shape from the build-app run that used to crash with
    // "expected: 'ephemeral' | 'branch' | 'patch', received: undefined".
    const text = JSON.stringify({
      approved: false,
      reasoning:
        'WebGL shader math is incorrect; grid coords mismatch with mouse events',
    });
    const v = parseVerdict(text);
    expect(v.approved).toBe(false);
    if (!v.approved) {
      expect(v.scope).toBe('ephemeral');
      expect(v.modifications).toEqual({});
      expect(typeof v.reasoning).toBe('string');
    }
  });

  it('parseVerdict still preserves a well-formed negative verdict verbatim', () => {
    const text = JSON.stringify({
      approved: false,
      reasoning: 'tighten prompt',
      scope: 'patch',
      modifications: { systemPromptAppend: 'Be concise.' },
    });
    const v = parseVerdict(text);
    expect(v.approved).toBe(false);
    if (!v.approved) {
      expect(v.scope).toBe('patch');
      expect(v.modifications).toEqual({ systemPromptAppend: 'Be concise.' });
    }
  });

  it('recovers a verdict with a stray premature closing brace (Haiku regression)', () => {
    // Observed in the 23:03:03 build run — the LLM emitted a `}` before
    // `"scope"`, prematurely closing the outer object. `JSON.parse` fails
    // at the comma after the stray close; our repair keeps the comma,
    // drops the bracket, and recovers the flat object.
    const raw = `{
      "approved": false,
      "reasoning": "Plan is structurally sound and targets correct tier (L1 executor). However, VISIBLE-DELIVERABLES checklist reveals critical gaps."
      },
      "scope": "ephemeral"
    }`;
    const v = parseVerdict(raw);
    expect(v.approved).toBe(false);
    if (!v.approved) {
      expect(v.scope).toBe('ephemeral');
      expect(v.reasoning).toMatch(/structurally sound/);
    }
  });

  it('still rejects a patch/branch verdict that forgot both scope and mods', () => {
    // The coercion defaults missing scope to "ephemeral", so a negative
    // verdict with NO scope is never promoted to a mutating retry. The
    // test below simulates Haiku explicitly asking for a patch without
    // supplying mods — the strict superRefine still bites.
    const res = verdictSchema.safeParse({
      approved: false,
      reasoning: 'bad plan',
      scope: 'patch',
      // modifications missing → coerced to {} → superRefine rejects
    });
    expect(res.success).toBe(false);
  });
});

describe('parsePlanTolerant', () => {
  // Single-action shape — coerced by planSchema.preprocess into a FanOutPlan with
  // a single degenerate subtask. Helper builds the expected post-coercion shape.
  const singleActionInput = {
    reasoning: 'because',
    proposedAction: 'write index.html',
    expectedOutput: 'live URL',
  };
  const expectedCoerced = {
    reasoning: 'because',
    proposedAction: 'write index.html',
    expectedOutput: 'live URL',
    subtasks: [{ description: 'write index.html' }],
    aggregation: { mode: 'concat' },
  };

  it('coerces a single-action plan object into a single-subtask fan-out plan', () => {
    expect(parsePlanTolerant(JSON.stringify(singleActionInput))).toEqual(expectedCoerced);
  });

  it('unwraps a [strategy, plan] array (L2 non-fallback shape leaking into fallback)', () => {
    const strategy = { strategy: 'reuse', target: 'Fluorine', reasoning: 'pf' };
    const wrapped = JSON.stringify([strategy, singleActionInput]);
    expect(parsePlanTolerant(wrapped)).toEqual(expectedCoerced);
  });

  it('unwraps a single-element [plan] array', () => {
    expect(parsePlanTolerant(JSON.stringify([singleActionInput]))).toEqual(expectedCoerced);
  });

  it('surfaces a ValidationError on non-plan shapes', () => {
    expect(() => parsePlanTolerant('{"foo": 1}')).toThrow(/schema validation failed/);
  });

  it('tolerates JSON inside a ```json fence', () => {
    const fenced = '```json\n' + JSON.stringify(singleActionInput) + '\n```';
    expect(parsePlanTolerant(fenced)).toEqual(expectedCoerced);
  });

  it('unwraps a {plan: {...}} wrapper (observed in fallback regressions)', () => {
    const wrapped = JSON.stringify({ plan: singleActionInput });
    expect(parsePlanTolerant(wrapped)).toEqual(expectedCoerced);
  });

  it('unwraps a {strategy, plan} combined envelope', () => {
    const envelope = JSON.stringify({
      strategy: { strategy: 'reuse', target: 'Water', reasoning: 'pf' },
      plan: singleActionInput,
    });
    expect(parsePlanTolerant(envelope)).toEqual(expectedCoerced);
  });

  it('picks the plan-shaped candidate from a narrative with multiple JSON objects', () => {
    const text = `Decided to delegate.

{"strategy": "reuse", "target": "Water"}

And here is the actual plan:

${JSON.stringify(singleActionInput)}`;
    expect(parsePlanTolerant(text)).toEqual(expectedCoerced);
  });

  it('passes a fan-out plan through without coercion (subtasks preserved)', () => {
    const fanout = {
      reasoning: 'decompose',
      subtasks: [
        { description: 'write layout' },
        { description: 'write logic' },
      ],
      aggregation: { mode: 'llm-synthesize', instruction: 'merge into index.html' },
      expectedOutput: 'working app',
    };
    expect(parsePlanTolerant(JSON.stringify(fanout))).toEqual(fanout);
  });
});

describe('parsePlanWithFallback', () => {
  const canonicalInput = {
    reasoning: 'r',
    proposedAction: 'a',
    expectedOutput: 'e',
  };
  const canonicalExpected = {
    reasoning: 'r',
    proposedAction: 'a',
    expectedOutput: 'e',
    subtasks: [{ description: 'a' }],
    aggregation: { mode: 'concat' },
  };
  const fb = {
    reasoning: 'SYN',
    proposedAction: 'SYN',
    expectedOutput: 'SYN',
  };
  // Fallback is ALSO coerced through the schema — callers can pass a
  // single-action shape and the returned Plan will have subtasks + aggregation.
  const fbCoerced = {
    reasoning: 'SYN',
    proposedAction: 'SYN',
    expectedOutput: 'SYN',
    subtasks: [{ description: 'SYN' }],
    aggregation: { mode: 'concat' },
  };

  it('returns the coerced parsed plan when parsing succeeds', () => {
    expect(parsePlanWithFallback(JSON.stringify(canonicalInput), fb)).toEqual(
      canonicalExpected
    );
  });

  it('returns the coerced fallback when LLM emits a strategy-only object', () => {
    const strategyOnly = JSON.stringify({ strategy: 'reuse', target: 'Aluminum' });
    expect(parsePlanWithFallback(strategyOnly, fb)).toEqual(fbCoerced);
  });

  it('returns the coerced fallback on completely malformed responses', () => {
    expect(parsePlanWithFallback('this is not JSON at all', fb)).toEqual(fbCoerced);
    expect(parsePlanWithFallback('', fb)).toEqual(fbCoerced);
    expect(parsePlanWithFallback('{incomplete: no quotes}', fb)).toEqual(fbCoerced);
  });

  it('returns the coerced fallback when LLM emits a result envelope by mistake', () => {
    const resultShape = JSON.stringify({ output: 'done', summary: 'ok' });
    expect(parsePlanWithFallback(resultShape, fb)).toEqual(fbCoerced);
  });
});

describe('findAllJsonObjects', () => {
  it('returns every top-level balanced {…} / […]', () => {
    const text = 'preamble {"a":1} interlude {"b":2} coda [1,2,3] tail';
    expect(findAllJsonObjects(text)).toEqual(['{"a":1}', '{"b":2}', '[1,2,3]']);
  });

  it('honours braces inside JSON strings (no false positives)', () => {
    const text = '{"reasoning":"contains } and { in string"} ok';
    expect(findAllJsonObjects(text)).toEqual([
      '{"reasoning":"contains } and { in string"}',
    ]);
  });

  it('skips unbalanced openers gracefully', () => {
    const text = 'trailing { no close here';
    expect(findAllJsonObjects(text)).toEqual([]);
  });
});

describe('parseWith — candidate fallback for multi-object responses', () => {
  it('picks the LAST balanced object that schema-validates when the first extract fails', () => {
    // Mimics the Tetris-run crash: narrative with an embedded pseudo-JSON
    // `{ score, level, state }` block, then the real payload at the end.
    const text = `Here is my summary:

**State shape**: { score, level, lines, state }
    - score: number
    - state: 'playing' or 'gameover'

And the required response:

{"output": {"url": "http://localhost:8000/"}, "summary": "built"}`;
    const parsed = parseWith(resultPayloadSchema, text);
    expect((parsed.output as { url: string }).url).toBe(
      'http://localhost:8000/'
    );
    expect(parsed.summary).toBe('built');
  });

  it('still returns the strict extract when it already validates', () => {
    const text = '{"output":"x","summary":"ok"}';
    expect(parseWith(resultPayloadSchema, text)).toEqual({
      output: 'x',
      summary: 'ok',
    });
  });

  it('throws a ValidationError when NO candidate validates', () => {
    // Either the original extractJson error or the schema-validation
    // error surfaces — both are ValidationError instances and both
    // carry a helpful diagnostic excerpt.
    const text = 'prose only, no real JSON here {not valid}';
    expect(() => parseWith(resultPayloadSchema, text)).toThrow(
      /(schema validation failed|JSON parse failed)/
    );
  });
});

describe('repairPrematureClose', () => {
  it('returns null when the JSON is already balanced', () => {
    expect(repairPrematureClose('{"a":1,"b":2}')).toBeNull();
    expect(repairPrematureClose('[1,2,3]')).toBeNull();
  });

  it('strips a stray outer `}` and keeps the trailing comma as a field separator', () => {
    const raw = `{
      "approved": false,
      "reasoning": "bad"
      },
      "scope": "ephemeral"
    }`;
    const repaired = repairPrematureClose(raw);
    expect(repaired).not.toBeNull();
    const parsed = JSON.parse(repaired!);
    expect(parsed).toEqual({ approved: false, reasoning: 'bad', scope: 'ephemeral' });
  });

  it('preserves nested objects inside strings (no false positives)', () => {
    const raw = '{"reasoning":"contains }, inside","scope":"ephemeral"}';
    // Valid JSON — nothing should be repaired.
    expect(repairPrematureClose(raw)).toBeNull();
  });

  it('handles multiple stray closes in sequence', () => {
    const raw = `{
      "a": 1},
      "b": 2},
      "c": 3
    }`;
    const repaired = repairPrematureClose(raw);
    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!)).toEqual({ a: 1, b: 2, c: 3 });
  });
});

describe('isEffectivelyEmptyMods', () => {
  it('detects empty / undefined / whitespace-equivalent fields', () => {
    expect(isEffectivelyEmptyMods(undefined)).toBe(true);
    expect(isEffectivelyEmptyMods({})).toBe(true);
    expect(isEffectivelyEmptyMods({ addTools: [], removeTools: [] })).toBe(true);
    expect(isEffectivelyEmptyMods({ additionalContext: '' })).toBe(true);
    expect(isEffectivelyEmptyMods({ params: {} })).toBe(true);
  });

  it('flags as non-empty when any field carries content', () => {
    expect(isEffectivelyEmptyMods({ systemPromptAppend: 'x' })).toBe(false);
    expect(isEffectivelyEmptyMods({ params: { temperature: 0.1 } })).toBe(false);
    expect(isEffectivelyEmptyMods({ removeTools: ['foo'] })).toBe(false);
  });
});
