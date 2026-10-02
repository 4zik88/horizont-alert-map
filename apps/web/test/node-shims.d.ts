// Minimal typings for the Node test runner. The web package has no @types/node (it is
// a browser app); these cover exactly what the tests use.
declare module 'node:test' {
  type Fn = () => void | Promise<void>;
  export function test(name: string, fn: Fn): void;
  export function describe(name: string, fn: () => void): void;
  export const it: typeof test;
}
declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
    match(value: string, re: RegExp, message?: string): void;
    doesNotMatch(value: string, re: RegExp, message?: string): void;
    throws(fn: () => unknown, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
