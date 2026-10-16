/**
 * The built-ins Vitest's equality reaches, by owner: what the parent-owned
 * runner's integrity guard (`src/tools/parentTestSetup.ts`) watches before and
 * after every matcher, and what a parent suite may not spy on
 * (`src/atoms/parentSuiteCheck.ts`). One list, so the plan-time refusal and
 * the run-time detection cannot drift apart. Derived from what
 * `@vitest/expect`'s `equals`, `iterableEquality`, `arrayBufferEquality` and
 * `typeEquality` read under the pinned Vitest; re-derive it on every bump.
 *
 * Deliberately absent: the global `Date` binding and its statics, `JSON`,
 * `Promise` statics and `Math`, which fake timers, `vi.spyOn(Date, 'now')`,
 * zone.js and seeded random generators legitimately replace.
 */
export const WATCHED_STATICS: Readonly<Record<string, readonly string[]>> = {
  Object: ['is', 'keys', 'getOwnPropertySymbols', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getPrototypeOf',
    'hasOwn', 'entries', 'values', 'assign', 'defineProperty', 'defineProperties', 'create', 'getOwnPropertyNames'],
  Array: ['isArray', 'from', 'of'],
  Number: ['isNaN'],
  Reflect: ['get', 'has', 'ownKeys', 'apply'],
  ArrayBuffer: ['isView'],
  Error: ['isError'],
};

/** String-keyed prototype members; the guard adds the symbol-keyed ones and the iterator prototypes. */
export const WATCHED_PROTOTYPES: Readonly<Record<string, readonly string[]>> = {
  Object: ['toString', 'hasOwnProperty', 'propertyIsEnumerable', 'valueOf'],
  Function: ['call', 'apply', 'bind', 'toString'],
  Array: ['entries', 'every', 'some', 'keys', 'values', 'map', 'filter', 'forEach', 'includes', 'indexOf'],
  Map: ['has', 'get', 'size', 'entries', 'values', 'keys'],
  Set: ['has', 'size', 'entries', 'values', 'keys'],
  DataView: ['getUint8', 'getInt8', 'byteLength', 'byteOffset', 'buffer'],
  ArrayBuffer: ['byteLength'],
  RegExp: ['source', 'flags', 'test', 'exec'],
  Date: ['getTime', 'valueOf'],
  String: ['valueOf', 'includes', 'indexOf'],
};
