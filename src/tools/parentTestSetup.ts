/**
 * The parent-owned runner's assertion-integrity guard, a Vitest `setupFiles`
 * entry. It runs in the TEST THREAD, before the suite module, and therefore
 * before any code under test, is loaded (review 2026-10-16, F6: an imported
 * module could `expect.extend({ toBe: () => ({ pass: true }) })`, patch
 * `Object.is`, or return an object with an `asymmetricMatch` method, and turn a
 * wrong implementation into `passed`).
 *
 * It makes forging DETECTABLE, not impossible: a violation throws
 * `[atoma-integrity:<guard nonce>] <what>`, the host reads that tag as the
 * subject-caused `assertions-tampered`, and the flag is sticky, so a violation
 * the code under test catches still fails the file in `afterAll`. What a
 * determined adversary can still do is listed once, in
 * docs/decisions/parent-owned-tests-2026-10-16.md.
 *
 *  - Framework objects (the Assertion prototype, the matcher tables, `expect`,
 *    `test`, `describe`, `vi`) are locked: own properties become
 *    non-writable and non-configurable, new names stay possible.
 *  - Every matcher is wrapped: it scans the actual value and its arguments for
 *    forged asymmetric matchers, checks the watched built-ins, runs, and
 *    checks them again.
 *  - `expect.extend` ignores a built-in name, tags a name someone else took
 *    first, and wraps and locks what it adds.
 *
 * Nothing here may rely on a built-in the code under test could replace after
 * setup: every one it calls is saved first and called through the saved
 * `Reflect.apply`.
 */
/* eslint-disable @typescript-eslint/unbound-method -- built-ins are saved before code under test can replace them, then called through the saved Reflect.apply */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as processBindings from 'node:process';
import { afterAll, beforeEach, chai, describe, expect, it, suite, test, vi } from 'vitest';
import { WATCHED_PROTOTYPES, WATCHED_STATICS } from '../contracts/assertionIntegrity.js';

type Bag = Record<PropertyKey, unknown>;

// 1. The built-ins this file itself uses, saved before anything else runs.
const apply = Reflect.apply;
const ownKeys = Reflect.ownKeys;
const has = Reflect.has;
const defineProperty = Object.defineProperty;
const describeOwn = Object.getOwnPropertyDescriptor;
const getPrototypeOf = Object.getPrototypeOf;
const is = Object.is;
const hasOwn = Object.hasOwn;
const freeze = Object.freeze;
const isView = ArrayBuffer.isView;
const isArray = Array.isArray;
const objectToString = Object.prototype.toString;
const functionToString = Function.prototype.toString;
const SafeSet = Set;
const setHas = Set.prototype.has;
const setAdd = Set.prototype.add;
const mapEntries = Map.prototype.entries;
const setValues = Set.prototype.values;
const mapIteratorNext = getPrototypeOf(new Map().entries()).next as () => IteratorResult<[unknown, unknown]>;
const setIteratorNext = getPrototypeOf(new Set().values()).next as () => IteratorResult<unknown>;
const SafeMap = Map;
const mapGet = Map.prototype.get;
const mapSet = Map.prototype.set;
const SafeError = Error;
const flag = chai.util.flag;
const stderr = process.stderr;
const stderrWrite = process.stderr.write;
const AssertionPrototype = chai.Assertion.prototype as unknown as Bag;

const kind = (value: unknown): string => apply(objectToString, value, []);
const inSet = (set: Set<unknown>, value: unknown): boolean => apply(setHas, set, [value]);
const addTo = (set: Set<unknown>, value: unknown): void => { apply(setAdd, set, [value]); };
const isObjectLike = (value: unknown): value is object =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

function install(): void {
  // 3. The watched (object, key) pairs: what `equals`, `iterableEquality`,
  // `arrayBufferEquality`, `typeEquality` and their helpers read.
  const watched: Array<{ label: string; target: object; key: PropertyKey; value?: unknown; get?: unknown; present: boolean }> = [];
  const watch = (label: string, target: object, keys: readonly PropertyKey[]): void => {
    for (const key of keys) {
      const descriptor = describeOwn(target, key);
      const shown = typeof key === 'symbol' ? `[${String(key.description)}]` : String(key);
      if (!descriptor) watched[watched.length] = { label: `${label}.${shown}`, target, key, present: false };
      else if ('value' in descriptor) watched[watched.length] = { label: `${label}.${shown}`, target, key, value: descriptor.value, present: true };
      else watched[watched.length] = { label: `${label}.${shown}`, target, key, get: descriptor.get, present: true };
    }
  };
  const iteratorPrototype = getPrototypeOf(getPrototypeOf([][Symbol.iterator]())) as object;
  const owners: Readonly<Record<string, object>> = { Object, Array, Number, Reflect, ArrayBuffer, Error, Function, Map, Set,
    DataView, RegExp, Date, String };
  for (const [name, keys] of Object.entries(WATCHED_STATICS)) watch(name, owners[name]!, keys);
  for (const [name, keys] of Object.entries(WATCHED_PROTOTYPES)) {
    watch(`${name}.prototype`, (owners[name] as { prototype: object }).prototype, keys);
  }
  watch('Array.prototype', Array.prototype, [Symbol.iterator]);
  watch('Map.prototype', Map.prototype, [Symbol.iterator]);
  watch('Set.prototype', Set.prototype, [Symbol.iterator]);
  watch('%MapIteratorPrototype%', getPrototypeOf(new Map().entries()) as object, ['next']);
  watch('%SetIteratorPrototype%', getPrototypeOf(new Set().values()) as object, ['next']);
  watch('%ArrayIteratorPrototype%', getPrototypeOf([][Symbol.iterator]()) as object, ['next']);
  watch('%StringIteratorPrototype%', getPrototypeOf(''[Symbol.iterator]()) as object, ['next']);
  watch('%IteratorPrototype%', iteratorPrototype, [Symbol.iterator]);
  watch('globalThis', globalThis, ['Object', 'Array', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Reflect', 'Number', 'String', 'Boolean',
    'Symbol', 'Function', 'RegExp', 'Error', 'ArrayBuffer', 'DataView', 'URL', 'Proxy']);
  // `asymmetricMatch` must stay absent from every intrinsic prototype: one on
  // Array.prototype turned `expect(3).toEqual([5])` green.
  const typedArrayPrototype = getPrototypeOf(Uint8Array.prototype) as object;
  const intrinsicPrototypes: Array<[string, object]> = [
    ['Object', Object.prototype], ['Array', Array.prototype], ['Function', Function.prototype], ['Map', Map.prototype],
    ['Set', Set.prototype], ['WeakMap', WeakMap.prototype], ['WeakSet', WeakSet.prototype], ['Date', Date.prototype],
    ['RegExp', RegExp.prototype], ['Error', Error.prototype], ['TypeError', TypeError.prototype], ['RangeError', RangeError.prototype],
    ['SyntaxError', SyntaxError.prototype], ['ReferenceError', ReferenceError.prototype], ['EvalError', EvalError.prototype],
    ['URIError', URIError.prototype], ['AggregateError', AggregateError.prototype], ['Promise', Promise.prototype],
    ['ArrayBuffer', ArrayBuffer.prototype], ['SharedArrayBuffer', SharedArrayBuffer.prototype], ['DataView', DataView.prototype],
    ['%TypedArray%', typedArrayPrototype], ['Int8Array', Int8Array.prototype], ['Uint8Array', Uint8Array.prototype],
    ['Uint8ClampedArray', Uint8ClampedArray.prototype], ['Int16Array', Int16Array.prototype], ['Uint16Array', Uint16Array.prototype],
    ['Int32Array', Int32Array.prototype], ['Uint32Array', Uint32Array.prototype], ['Float32Array', Float32Array.prototype],
    ['Float64Array', Float64Array.prototype], ['BigInt64Array', BigInt64Array.prototype], ['BigUint64Array', BigUint64Array.prototype],
    ['String', String.prototype], ['Number', Number.prototype], ['Boolean', Boolean.prototype], ['Symbol', Symbol.prototype],
    ['BigInt', BigInt.prototype],
  ];
  for (const [name, prototype] of intrinsicPrototypes) {
    watch(`${name}.prototype`, prototype, ['asymmetricMatch', Symbol.toStringTag]);
  }
  for (const [name, constructor] of [['Object', Object], ['Array', Array], ['Map', Map], ['Set', Set], ['Date', Date],
    ['RegExp', RegExp], ['Error', Error], ['URL', URL], ['ArrayBuffer', ArrayBuffer], ['DataView', DataView], ['Function', Function]] as const) {
    watch(name, constructor, [Symbol.hasInstance]);
  }
  intact = (): void => {
    for (let index = 0; index < watched.length; index += 1) {
      const entry = watched[index]!;
      const now = describeOwn(entry.target, entry.key);
      const same = !entry.present ? now === undefined
        : now !== undefined && (hasOwn(entry, 'value') ? hasOwn(now, 'value') && is(now.value, entry.value) : !hasOwn(now, 'value') && now.get === entry.get);
      if (!same) violation(`${entry.label} changed`);
    }
  };

  // 4. Genuine asymmetric matchers: instances whose prototype Vitest made.
  const asymmetricTable = (globalThis as Bag)[Symbol.for('asymmetric-matchers-object')] as Bag;
  const register = (instance: unknown): void => {
    if (!isObjectLike(instance)) return;
    let prototype = getPrototypeOf(instance) as object | null;
    if (prototype) addTo(genuine, prototype);
    while (prototype && prototype !== Object.prototype) {
      freeze(prototype);
      prototype = getPrototypeOf(prototype) as object | null;
    }
  };
  const exp = expect as unknown as Bag & { not: Bag };
  const samples: Array<() => unknown> = [
    () => expect.any(Number), () => expect.anything(), () => expect.objectContaining({}), () => expect.arrayContaining([]),
    () => expect.stringContaining(''), () => expect.stringMatching(/x/), () => expect.closeTo(0),
    () => (exp['schemaMatching'] as (schema: unknown) => unknown)({ '~standard': { version: 1, vendor: 'atoma', validate: () => ({ value: null }) } }),
  ];
  for (const sample of samples) register(sample());
  for (const name of ownKeys(asymmetricTable)) {
    const factory = asymmetricTable[name];
    if (typeof factory === 'function') { try { register(apply(factory, undefined, [])); } catch { /* needs a sample */ } }
  }

  // 5. Every matcher wrapped; 6. extend guarded; 7. testers and serializers refused.
  const builtins = new SafeSet<unknown>(ownKeys(AssertionPrototype));
  const added = new SafeMap<PropertyKey, string>();
  wrapPrototype(AssertionPrototype);
  const methods = AssertionPrototype['__methods'] as Bag | undefined;
  if (methods) {
    for (const name of ownKeys(methods)) {
      const behaviour = methods[name] as { method: (...args: unknown[]) => unknown };
      behaviour.method = guarded(behaviour.method, typeof name === 'string' ? name : String(name));
      freeze(behaviour);
    }
  }
  const originalExtend = (chai.expect as unknown as Bag)['extend'] as (target: unknown, matchers: unknown) => unknown;
  const extend = function guardedExtend(this: unknown, target: unknown, matchers: unknown): unknown {
    if (!isObjectLike(matchers) || !isObjectLike(target)) return apply(originalExtend, this, [target, matchers]);
    const kept = Object.create(null) as Bag;
    const names: PropertyKey[] = [];
    for (const name of ownKeys(matchers)) {
      const descriptor = describeOwn(matchers, name);
      if (!descriptor?.enumerable || typeof name !== 'string') continue;
      const matcher = (matchers as Bag)[name];
      // A built-in name keeps Vitest's matcher: nothing is forged, nobody is blamed.
      if (inSet(builtins, name)) continue;
      const source = typeof matcher === 'function' ? apply(functionToString, matcher, []) : '';
      if (has(AssertionPrototype, name)) {
        // The same text again is a re-registration (an extend in beforeEach); a
        // different one took a name first: imports evaluate before the suite body.
        if (apply(mapGet, added, [name]) === source) continue;
        violation(`expect.extend found the matcher name ${JSON.stringify(name)} already taken`);
      }
      kept[name] = matcher;
      names[names.length] = name;
      apply(mapSet, added, [name, source]);
    }
    const result = apply(originalExtend, this, [target, kept]);
    const matchersTable = ((globalThis as Bag)[Symbol.for('$$jest-matchers-object')] as { matchers: Bag }).matchers;
    for (const name of names) {
      const descriptor = describeOwn(AssertionPrototype, name);
      if (descriptor && hasOwn(descriptor, 'value') && typeof descriptor.value === 'function') {
        defineProperty(AssertionPrototype, name, { value: wrap(descriptor.value as (...args: unknown[]) => unknown, String(name)), writable: false, configurable: false, enumerable: descriptor.enumerable ?? false });
      }
      lockKey(matchersTable, name);
      lockKey(target, name);
      lockKey((target as Bag)['not'] as object, name);
      lockKey(asymmetricTable, name);
      const factory = (target as Bag)[name];
      if (typeof factory === 'function') { try { register(apply(factory, undefined, [])); } catch { /* needs a sample */ } }
    }
    return result;
  };
  defineProperty(chai.expect, 'extend', { value: extend, writable: true, configurable: true, enumerable: true });
  const refuseTesters = (): never => violation('expect.addEqualityTesters is unavailable to the parent-owned suite');
  const refuseSerializers = (): never => violation('expect.addSnapshotSerializer is unavailable to the parent-owned suite');
  const refuseOn = (target: Bag): void => {
    defineProperty(target, 'addEqualityTesters', { value: refuseTesters, writable: true, configurable: true, enumerable: true });
    defineProperty(target, 'addSnapshotSerializer', { value: refuseSerializers, writable: true, configurable: true, enumerable: true });
  };
  refuseOn(chai.expect as unknown as Bag);
  refuseOn(exp);
  freeze(((globalThis as Bag)[Symbol.for('$$jest-matchers-object')] as { customEqualityTesters: unknown[] }).customEqualityTesters);

  // 8. Lock the framework objects.
  const matchersTable = ((globalThis as Bag)[Symbol.for('$$jest-matchers-object')] as { matchers: Bag }).matchers;
  lockObject(AssertionPrototype);
  if (methods) lockObject(methods);
  lockObject(matchersTable);
  lockObject(asymmetricTable);
  lockObject(exp);
  lockObject(exp.not);
  lockObject(chai.expect);
  for (const name of ['$$jest-matchers-object', 'asymmetric-matchers-object', 'expect-global', 'matchers-object']) {
    lockKey(globalThis, Symbol.for(name));
  }
  for (const chain of [test, it, describe, suite] as unknown as Bag[]) {
    lockObject(chain);
    const fn = chain['fn'];
    if (isObjectLike(fn)) lockObject(fn);
  }
  lockObject(vi);

  beforeEach((context) => {
    const local = context.expect as unknown as Bag & { not: Bag };
    refuseOn(local);
    lockObject(local);
    lockObject(local.not);
  });
  afterAll(() => {
    if (tampered) throw new SafeError(tampered);
  });
}

/** The first violation, kept: a violation the code under test catches still fails the file. */
let tampered = '';
let intact: () => void = () => undefined;
const genuine = new SafeSet<unknown>();

function violation(what: string): never {
  const message = `[atoma-integrity:${guardNonce}] ${what}`;
  if (!tampered) {
    tampered = message;
    // Also on stderr, through Node's own primordials: a forgery that breaks
    // Vitest's runner (a replaced `call` or iterator) can lose the report's copy.
    try { apply(stderrWrite, stderr, [`${message}\n`]); } catch { /* the report still carries it */ }
  }
  throw new SafeError(tampered);
}

/** Vitest's own predicate, `isAsymmetric`: an object whose `asymmetricMatch` is a plain function. */
function asymmetric(value: object): boolean {
  if (typeof value !== 'object' || !has(value, 'asymmetricMatch')) return false;
  return kind((value as Bag)['asymmetricMatch']) === '[object Function]';
}

const SCAN_BUDGET = 10_000;

/**
 * Walks a value as `equals` would: own enumerable keys (getters called),
 * Map and Set entries through the saved iterators, and a mock's records. An
 * asymmetric node is a violation on the actual side, and on the expected side
 * unless Vitest made it. A node that throws is skipped; the walk stops at the
 * budget.
 */
function scan(value: unknown, side: 'actual' | 'expected', path: string, budget: { left: number }): void {
  const seen = new SafeSet<unknown>();
  const stack = Object.create(null) as Record<number, { value: unknown; path: string }>;
  let top = 0;
  stack[top++] = { value, path };
  while (top > 0 && budget.left > 0) {
    const node = stack[--top]!;
    const current = node.value;
    budget.left -= 1;
    if (!isObjectLike(current) || inSet(seen, current)) continue;
    addTo(seen, current);
    try {
      if (isView(current) || current instanceof ArrayBuffer) continue;
      if (asymmetric(current)) {
        const made = !describeOwn(current, 'asymmetricMatch') && inSet(genuine, getPrototypeOf(current));
        if (side === 'actual' || !made) violation(`unregistered asymmetric matcher at ${side} ${node.path}`);
        continue;
      }
      if (typeof current === 'function') {
        const mock = (current as unknown as Bag)['_isMockFunction'] === true ? (current as unknown as Bag)['mock'] as Bag | undefined : undefined;
        if (mock) {
          for (const key of ['calls', 'results', 'contexts', 'instances']) stack[top++] = { value: mock[key], path: `${node.path}.mock.${key}` };
        }
        continue;
      }
      if (current instanceof SafeMap) {
        const iterator = apply(mapEntries, current, []) as Iterator<[unknown, unknown]>;
        for (let step = apply(mapIteratorNext, iterator, []); !step.done && budget.left > 0;
          step = apply(mapIteratorNext, iterator, [])) {
          budget.left -= 1;
          stack[top++] = { value: step.value[0], path: `${node.path}<key>` };
          stack[top++] = { value: step.value[1], path: `${node.path}<value>` };
        }
      } else if (current instanceof SafeSet) {
        const iterator = apply(setValues, current, []) as Iterator<unknown>;
        for (let step = apply(setIteratorNext, iterator, []); !step.done && budget.left > 0;
          step = apply(setIteratorNext, iterator, [])) {
          budget.left -= 1;
          stack[top++] = { value: step.value, path: `${node.path}<entry>` };
        }
      }
      const length = isArray(current) ? (current as unknown[]).length : 0;
      const keys: readonly PropertyKey[] = length > budget.left ? [] : ownKeys(current);
      if (length > budget.left) {
        for (let index = 0; index < length && budget.left > 0; index += 1) {
          budget.left -= 1;
          stack[top++] = { value: (current as unknown[])[index], path: `${node.path}[${index}]` };
        }
      }
      for (let index = 0; index < keys.length && budget.left > 0; index += 1) {
        const key = keys[index]!;
        budget.left -= 1;
        try {
          const descriptor = describeOwn(current, key);
          if (!descriptor?.enumerable) continue;
          const child = hasOwn(descriptor, 'value') ? descriptor.value : (current as Bag)[key];
          stack[top++] = { value: child, path: `${node.path}.${typeof key === 'symbol' ? `[${String(key.description)}]` : key}` };
        } catch (error) {
          if (tampered) throw error;
        }
      }
    } catch (error) {
      if (tampered) throw error;
      // A node that throws on inspection is skipped, as a Proxy over a Map is.
    }
  }
}

/**
 * Never scanned: matchers whose result reads identity or type only (`equals`
 * never runs), and the two methods Vitest calls on every assertion with its
 * own task and flags.
 */
const UNSCANNED = new SafeSet<unknown>(['toBe', 'toBeInstanceOf', 'toBeTypeOf', 'toBeDefined', 'toBeUndefined', 'toBeNull',
  'toBeNaN', 'toBeTruthy', 'toBeFalsy', 'withTest', 'withContext']);

function guarded(original: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown {
  const scans = !inSet(UNSCANNED, name);
  return function (this: unknown, ...args: unknown[]): unknown {
    if (tampered) throw new SafeError(tampered);
    if (scans) {
      const budget = { left: SCAN_BUDGET };
      scan(apply(flag, undefined, [this, 'object']), 'actual', 'value', budget);
      for (let index = 0; index < args.length; index += 1) scan(args[index], 'expected', `argument ${index}`, budget);
    }
    intact();
    const result = apply(original, this, args);
    intact();
    return result;
  };
}

/** A wrapper carrying the original's own markers (`__vitest_poll_takeover__`). */
function wrap(original: (...args: unknown[]) => unknown, name: string): (...args: unknown[]) => unknown {
  const wrapper = guarded(original, name);
  for (const key of ownKeys(original)) {
    if (describeOwn(wrapper, key)) continue;
    const descriptor = describeOwn(original, key);
    if (descriptor) defineProperty(wrapper, key, descriptor);
  }
  return wrapper;
}

function wrapPrototype(prototype: Bag): void {
  for (const key of ownKeys(prototype)) {
    if (key === 'constructor' || key === 'assert') continue;
    const descriptor = describeOwn(prototype, key)!;
    const name = typeof key === 'symbol' ? String(key.description) : key;
    if ('value' in descriptor) {
      if (typeof descriptor.value === 'function') defineProperty(prototype, key, { ...descriptor, value: wrap(descriptor.value as (...args: unknown[]) => unknown, name) });
    } else if (descriptor.get) {
      // Property assertions (`.empty`, `.true`) run in their getter: checked, never scanned.
      const get = descriptor.get;
      defineProperty(prototype, key, { ...descriptor, get(this: unknown) {
        if (tampered) throw new SafeError(tampered);
        intact();
        const result: unknown = apply(get, this, []);
        intact();
        return result;
      } });
    }
  }
}

function lockKey(target: object, key: PropertyKey): void {
  const descriptor = describeOwn(target, key);
  if (!descriptor) return;
  if (hasOwn(descriptor, 'value')) descriptor.writable = false;
  descriptor.configurable = false;
  defineProperty(target, key, descriptor);
}

function lockObject(target: object): void {
  for (const key of ownKeys(target)) lockKey(target, key);
}

// Not the guard: what `existsSync` answers. The runner's Node permissions deny
// every path outside the copy, and under them `existsSync` THROWS
// ERR_ACCESS_DENIED where the operating system's own refusal (EACCES) and
// `fs.exists` both answer false. A module that probed for a system binary at
// import (`existsSync('/usr/bin/chromium')`) never loaded, and both of its
// suites read "failed 0/0" (run 760fef4c, 2026-10-17). The probe answers false
// again; nothing outside the copy becomes readable, and every other call keeps
// Node's answer, as it would on the operating system's refusal. Installed with
// the guard, so a fault here is the host's (`runner-error`), never the code's.
// Once per thread: `node:fs` outlives each isolated file.
function answerExistsLikeTheSystem(): void {
  const original = fs.existsSync;
  const marker = Symbol.for('atoma.existsSyncUnderPermissions');
  if (has(original, marker)) return;
  const existsSync = (target: fs.PathLike): boolean => {
    try {
      return original(target);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'ERR_ACCESS_DENIED') return false;
      throw error;
    }
  };
  defineProperty(existsSync, marker, { value: true });
  (fs as { existsSync: typeof existsSync }).existsSync = existsSync;
  // ESM named imports (`import { existsSync } from 'node:fs'`) see it too. The
  // sync re-binds EVERY built-in, and Vitest has already replaced
  // `process.exit` on the process object: each `node:process` binding is held
  // at its imported value across the sync, or `import { exit }` would throw
  // Vitest's catchable error and an exit inside a catch-all would pass where
  // it failed (review 2026-10-17).
  const bindings = processBindings as unknown as Bag;
  const live = process as unknown as Bag;
  const held: Array<[string, unknown]> = [];
  for (const key of ownKeys(bindings)) {
    if (typeof key !== 'string' || key === 'default') continue;
    const descriptor = describeOwn(live, key);
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.writable || is(descriptor.value, bindings[key])) continue;
    held[held.length] = [key, descriptor.value];
    live[key] = bindings[key];
  }
  try {
    syncBuiltinESMExports();
  } finally {
    for (const [key, value] of held) live[key] = value;
  }
}

// 2. The nonces. Read and scrubbed from the provided context before the suite
// module loads, so the suite and the code it imports see neither. The setup
// nonce stays in this block, captured by no closure: only a setup failure can
// produce its tag.
let guardNonce = '';
{
  const workerState = (globalThis as Bag)['__vitest_worker__'] as { providedContext?: Bag } | undefined;
  const provided = workerState?.providedContext;
  const setupNonce = provided?.['atomaSetup'];
  const guard = provided?.['atomaGuard'];
  if (typeof setupNonce !== 'string' || typeof guard !== 'string' || !/^[0-9a-f]{32}$/.test(setupNonce) || !/^[0-9a-f]{32}$/.test(guard)) {
    throw new Error('Atoma integrity setup: the host provided no integrity nonce');
  }
  delete provided!['atomaSetup'];
  delete provided!['atomaGuard'];
  guardNonce = guard;
  try {
    install();
    answerExistsLikeTheSystem();
  } catch (error) {
    throw new Error(`[atoma-integrity-setup:${setupNonce}] the assertion-integrity guard could not be installed: ${String(error).slice(0, 300)}`);
  }
  // The host passes nothing the guard did not see installed.
  apply(stderrWrite, stderr, [`[atoma-integrity-ready:${setupNonce}]\n`]);
}
