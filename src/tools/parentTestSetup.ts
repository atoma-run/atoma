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
import { resolve, sep } from 'node:path';
import * as processBindings from 'node:process';
import { fileURLToPath } from 'node:url';
import { getSystemErrorMap } from 'node:util';
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

// Not the guard: what a path outside the readable set answers. The runner's
// Node permissions refuse every path outside the copy (also HOME and the
// temporary directory) and the runner's own modules with `ERR_ACCESS_DENIED`,
// a code no file API documents: a module probing the system at import never
// loaded and its suites read "failed 0/0" (run 760fef4c, 2026-10-17:
// `existsSync('/usr/bin/chromium')`). Such a path is ABSENT for the code under
// test, as in a container that mounts only the copy: `exists` and `existsSync`
// answer false, `throwIfNoEntry: false` answers undefined, and every other
// read raises the ENOENT Node raises for a missing path, thrown, called back
// (never before the call returns) or rejected as the API does; streams open
// through `fs.open`. Only a READ refusal of the path the caller NAMED
// converts, decided by Node's own `process.permission.has`: nothing becomes
// readable, and so do the directories above the readable set, which exist
// (Node's asynchronous `realpath` walks them for a file inside the copy, and
// is refused there as before). Writes keep Node's refusal, including those
// that read first: an open for writing, a truncate, an `rm` (with `force`, a
// read answered "absent" would have made it succeed: review 2026-10-17).
// Installed with the guard, so a fault here is the host's (`runner-error`),
// never the code's. Once per thread: `node:fs` outlives each isolated file.
type Fn = (...args: unknown[]) => unknown;
/** This file, whose frames a converted error's stack drops. */
const SETUP_FILE = ((): string => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return '';
  }
})();
/** Each read and the syscall its own ENOENT names (Node 24.20 and 24.22, measured). */
const READS: ReadonlyArray<readonly [name: string, syscall: string]> = [
  ['access', 'access'], ['lstat', 'lstat'], ['open', 'open'], ['opendir', 'opendir'], ['readdir', 'scandir'],
  ['readFile', 'open'], ['readlink', 'readlink'], ['realpath', 'lstat'], ['stat', 'stat'], ['statfs', 'statfs'],
];
function answerOutsideAsAbsent(): void {
  const marker = Symbol.for('atoma.absentOutsideTheCopy');
  if (has(fs.existsSync, marker)) return;
  const permission = (process as { permission?: { has: (scope: string, reference?: string) => boolean } }).permission;
  if (!permission) return;
  const permissionHas = permission.has;
  const nextTick = process.nextTick;
  const roots: string[] = [];
  for (const flag of process.execArgv) if (flag.startsWith('--allow-fs-read=')) roots[roots.length] = resolve(flag.slice(16));
  let errno = -2;
  for (const [code, [name]] of getSystemErrorMap()) if (name === 'ENOENT') errno = code;
  const captureStackTrace = SafeError.captureStackTrace;
  const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
  /** An open that only reads; any other is a write, and keeps Node's refusal. */
  const readOnly = (flags: unknown): boolean => flags === undefined || flags === null ||
    (typeof flags === 'number' ? (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) === 0
      : typeof flags === 'string' && /^(?:r|rs|sr)$/.test(flags));
  /** `open(path, flags?, mode?, cb)` and `readFile(path, options?, cb)`: whether this call only reads. */
  const opensToRead = (args: readonly unknown[]): boolean => readOnly(typeof args[1] === 'function' ? undefined : args[1]);
  const readsToRead = (args: readonly unknown[]): boolean => {
    const options = args[1];
    return !isObjectLike(options) || typeof options === 'function' || readOnly((options as Bag)['flag']);
  };
  /** Node's own test for a URL-like argument (`isURL`): it reads such an object as a file URL. */
  const urlLike = (target: unknown): target is { href: string; protocol: string } => isObjectLike(target) &&
    typeof (target as Bag)['href'] === 'string' && typeof (target as Bag)['protocol'] === 'string' &&
    (target as Bag)['auth'] === undefined && (target as Bag)['path'] === undefined;
  const named = (target: unknown): string | undefined => {
    if (typeof target === 'string') return target;
    if (isView(target)) return Buffer.from(target.buffer, target.byteOffset, target.byteLength).toString();
    if (target instanceof URL) return target.protocol === 'file:' ? fileURLToPath(target) : undefined;
    return urlLike(target) && target.protocol === 'file:' ? fileURLToPath(target.href) : undefined;
  };
  const readable = (shown: string): boolean => apply(permissionHas, permission, ['fs.read', shown]) === true;
  /** The path the caller named when it is outside the readable set and not above it. */
  const absentPath = (target: unknown): string | undefined => {
    try {
      const shown = named(target);
      if (shown === undefined || readable(shown)) return undefined;
      const full = resolve(shown);
      const prefix = full.endsWith(sep) ? full : `${full}${sep}`;
      return roots.some(root => root.startsWith(prefix)) ? undefined : shown;
    } catch {
      return undefined;
    }
  };
  /**
   * The runner's own frames never read as the fault: `caller` cuts a
   * synchronous stack there, and any frame left in this file is dropped, as a
   * promise's rejection keeps its own (second review 2026-10-17).
   */
  const fromCaller = (error: Error & Bag, caller?: Fn): Error => {
    if (caller) apply(captureStackTrace, SafeError, [error, caller]);
    if (SETUP_FILE) error.stack = String(error.stack).split('\n').filter(line => !line.includes(SETUP_FILE)).join('\n');
    return error;
  };
  /** Node's ENOENT for a missing path. */
  const enoent = (syscall: string, shown: string, caller?: Fn): Error => {
    const error = new SafeError(`ENOENT: no such file or directory, ${syscall} '${shown}'`) as Error & Bag;
    error['errno'] = errno;
    error['code'] = 'ENOENT';
    error['syscall'] = syscall;
    error['path'] = shown;
    return fromCaller(error, caller);
  };
  /** Node's own write refusal, for a write that would read first. */
  const writeRefusal = (shown: string, caller: Fn): Error => {
    const error = new SafeError('Access to this API has been restricted. Use --allow-fs-write to manage permissions.') as Error & Bag;
    error['code'] = 'ERR_ACCESS_DENIED';
    error['permission'] = 'FileSystemWrite';
    error['resource'] = resolve(shown);
    return fromCaller(error, caller);
  };
  const absent = (error: unknown, syscall: string, target: unknown, caller?: Fn): Error | undefined => {
    if (!isObjectLike(error) || (error as Bag)['code'] !== 'ERR_ACCESS_DENIED' || (error as Bag)['permission'] !== 'FileSystemRead') return undefined;
    const shown = absentPath(target);
    return shown === undefined ? undefined : enoent(syscall, shown, caller);
  };
  /** `reads(args)` false: this call writes, and Node's answer stands as it is. */
  type Reads = (args: readonly unknown[]) => boolean;
  const synchronous = (original: Fn, syscall: string, reads?: Reads): Fn => function wrapper(this: unknown, ...args: unknown[]): unknown {
    try {
      return apply(original, this, args);
    } catch (error) {
      const answer = reads && !reads(args) ? undefined : absent(error, syscall, args[0], wrapper);
      if (!answer) throw error;
      const options = args[1];
      if ((syscall === 'stat' || syscall === 'lstat') && isObjectLike(options) && (options as Bag)['throwIfNoEntry'] === false) return undefined;
      throw answer;
    }
  };
  const callback = (original: Fn, syscall: string, reads?: Reads): Fn => function (this: unknown, ...args: unknown[]): unknown {
    const done = args[args.length - 1];
    if (typeof done !== 'function' || (reads && !reads(args))) return apply(original, this, args);
    const target = args[0];
    // Node calls a refused request back before it returns; the system never does.
    const later = (answer: Error): undefined => { apply(nextTick, process, [done, answer]); return undefined; };
    args[args.length - 1] = function answered(this: unknown, ...results: unknown[]): unknown {
      const answer = absent(results[0], syscall, target, answered);
      return answer ? later(answer) : apply(done, this, results);
    };
    try {
      return apply(original, this, args);
    } catch (error) {
      const answer = absent(error, syscall, target);
      if (!answer) throw error;
      return later(answer);
    }
  };
  const promised = (original: Fn, syscall: string, reads?: Reads): Fn => async function (this: unknown, ...args: unknown[]): Promise<unknown> {
    try {
      return await apply(original, this, args);
    } catch (error) {
      throw (reads && !reads(args) ? undefined : absent(error, syscall, args[0])) ?? error;
    }
  };
  /** Replaces `owner[name]`, keeping the original's own markers (`native`, `util.promisify.custom`). */
  const replace = (owner: Bag, name: string, wrapper: Fn): void => {
    const original = owner[name] as Fn;
    for (const key of ownKeys(original)) {
      const descriptor = key === 'prototype' || describeOwn(wrapper, key) ? undefined : describeOwn(original, key);
      if (descriptor) defineProperty(wrapper, key, descriptor);
    }
    defineProperty(wrapper, 'name', { value: original.name, configurable: true });
    defineProperty(wrapper, 'length', { value: original.length, configurable: true });
    owner[name] = wrapper;
  };
  const module = fs as unknown as Bag;
  const promises = fs.promises as unknown as Bag;
  const readsOnly: Readonly<Record<string, Reads>> = { open: opensToRead, readFile: readsToRead };
  for (const [name, syscall] of READS) {
    if (name !== 'realpath') replace(module, `${name}Sync`, synchronous(module[`${name}Sync`] as Fn, syscall, readsOnly[name]));
    replace(module, name, callback(module[name] as Fn, syscall, readsOnly[name]));
    replace(promises, name, promised(promises[name] as Fn, name === 'realpath' ? 'realpath' : syscall, readsOnly[name]));
  }
  // Node's JavaScript `realpathSync` walks with an UNCHECKED lstat (on Linux it
  // answered `/etc/hosts`) and turns any other argument into a string once:
  // converted here once, so the check and the call read the same path. The
  // call runs first, so its own argument errors keep their order, and its
  // answer is never returned for a path outside the readable set.
  const realpathSync = module['realpathSync'] as Fn;
  replace(module, 'realpathSync', function wrapper(this: unknown, ...args: unknown[]): unknown {
    if (typeof args[0] !== 'string' && !isView(args[0]) && !(args[0] instanceof URL) && !urlLike(args[0])) args[0] = `${args[0] as string}`;
    let result: unknown;
    try {
      result = apply(realpathSync, this, args);
    } catch (error) {
      throw absent(error, 'lstat', args[0], wrapper) ?? error;
    }
    const shown = absentPath(args[0]);
    if (shown !== undefined) throw enoent('lstat', shown, wrapper);
    return result;
  });
  // A removal reads first, and a read answered "absent" let `force` succeed
  // where Node refuses: outside the readable set it gets Node's write refusal.
  // Only the argument shapes Node accepts: any other, Node refuses on its own,
  // synchronously, before it reads anything (second review 2026-10-17).
  const plainRemoval = (args: readonly unknown[]): boolean => {
    const shown = named(args[0]);
    const options = args[1];
    return shown !== undefined && !shown.includes('\0') && (options === undefined || typeof options === 'function' || (isObjectLike(options) &&
      ['force', 'recursive'].every(key => (options as Bag)[key] === undefined || typeof (options as Bag)[key] === 'boolean') &&
      ['maxRetries', 'retryDelay'].every(key => (options as Bag)[key] === undefined || typeof (options as Bag)[key] === 'number')));
  };
  for (const [owner, name] of [[module, 'rm'], [module, 'rmdir'], [promises, 'rm'], [promises, 'rmdir']] as const) {
    const original = owner[name] as Fn;
    replace(owner, name, owner === promises
      ? async function removal(this: unknown, ...args: unknown[]): Promise<unknown> {
        const shown = plainRemoval(args) ? absentPath(args[0]) : undefined;
        if (shown !== undefined) throw writeRefusal(shown, removal);
        return await apply(original, this, args);
      }
      : function removal(this: unknown, ...args: unknown[]): unknown {
        const done = args[args.length - 1];
        const shown = typeof done === 'function' && plainRemoval(args) ? absentPath(args[0]) : undefined;
        if (shown === undefined) return apply(original, this, args);
        apply(nextTick, process, [done, writeRefusal(shown, removal)]);
        return undefined;
      });
  }
  for (const [owner, wrap] of [[module['realpathSync'], synchronous], [module['realpath'], callback]] as const) {
    const native = describeOwn(owner, 'native');
    if (!native || typeof native.value !== 'function') continue;
    const wrapped = wrap(native.value as Fn, 'realpath');
    defineProperty(wrapped, 'name', { value: (native.value as Fn).name, configurable: true });
    defineProperty(owner as object, 'native', { ...native, value: wrapped });
  }
  // Every refused path answers false, the directories above included, as an unreadable one does on the system.
  const existsSync = fs.existsSync as Fn;
  replace(module, 'existsSync', function (this: unknown, ...args: unknown[]): boolean {
    try {
      return apply(existsSync, this, args) === true;
    } catch (error) {
      if (isObjectLike(error) && (error as Bag)['code'] === 'ERR_ACCESS_DENIED') return false;
      throw error;
    }
  });
  const exists = fs.exists as Fn;
  replace(module, 'exists', function (this: unknown, ...args: unknown[]): unknown {
    const done = args[1];
    // A URL Node cannot read as a path answers false there: never a throw from here.
    let shown: string | undefined;
    try { shown = typeof done === 'function' ? named(args[0]) : undefined; } catch { shown = undefined; }
    if (shown === undefined || readable(shown)) return apply(exists, this, args);
    apply(nextTick, process, [done, false]);
    return undefined;
  });
  defineProperty(fs.existsSync, marker, { value: true });
  // ESM named imports (`import { statSync } from 'node:fs'`, `node:fs/promises`)
  // see them too. The sync re-binds EVERY built-in, and Vitest has already
  // replaced `process.exit` on the process object: each `node:process` binding
  // is held at its imported value across the sync, or `import { exit }` would
  // throw Vitest's catchable error and an exit inside a catch-all would pass
  // where it failed (review 2026-10-17).
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
    answerOutsideAsAbsent();
  } catch (error) {
    throw new Error(`[atoma-integrity-setup:${setupNonce}] the assertion-integrity guard could not be installed: ${String(error).slice(0, 300)}`);
  }
  // The host passes nothing the guard did not see installed.
  apply(stderrWrite, stderr, [`[atoma-integrity-ready:${setupNonce}]\n`]);
}
