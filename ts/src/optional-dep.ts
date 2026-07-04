/**
 * loadOptionalDep — load a server-only OPTIONAL runtime dependency by name, or null if absent.
 *
 * The specifier is passed as a VARIABLE, never a string literal, on purpose. A literal
 * `import('hypercore')` is statically analyzable, so browser bundlers (webpack / Next.js) try to
 * resolve it at build time and hard-fail with `Module not found: Can't resolve 'hypercore'` — even
 * though these deps are server/desktop-only, tsup-external, and load lazily. A variable specifier
 * is opaque to that static analysis, so the import stays a genuine runtime concern and the engine
 * barrel bundles cleanly for the browser with no consumer `resolve.fallback` shim.
 *
 * All callers degrade gracefully on null (JSONL / in-memory fallback), so absence is never fatal.
 * Works in both the ESM and CJS builds (a bare `require()` throws in the ESM bundle).
 */
export async function loadOptionalDep<T>(name: string): Promise<T | null> {
  try {
    const mod = (await import(name)) as unknown as T | { default: T }
    return typeof mod === 'function' ? (mod as T) : (mod as { default: T }).default
  } catch {
    return null
  }
}
