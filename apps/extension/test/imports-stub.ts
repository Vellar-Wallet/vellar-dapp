/**
 * Test-only stand-in for WXT's virtual `#imports` module.
 *
 * `entrypoints/background.ts` imports `defineBackground` from `#imports`, which
 * WXT resolves at build time but Vitest cannot resolve on disk. The stub keeps
 * the identity semantics we need in tests: the default export is the setup
 * callback itself, so importing the module never executes the production
 * wrapper (browser listeners, error reporters, etc.). Production builds still
 * use the real WXT module; this alias lives only in vitest.config.ts.
 */
export function defineBackground<T>(setup: T): T {
  return setup;
}
