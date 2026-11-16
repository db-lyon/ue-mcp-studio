/**
 * Web Storage for the jsdom tests on a Node that has its own.
 *
 * Node 25 and later define a global `localStorage` and `sessionStorage`,
 * which are undefined unless Node is started with --localstorage-file.
 * Vitest's jsdom environment does not replace a global that already exists,
 * so a test's `localStorage.clear()` met Node's undefined one instead of
 * jsdom's. Here jsdom's storage takes their place, in jsdom tests only.
 */
const dom = (globalThis as { jsdom?: { window: { localStorage: Storage; sessionStorage: Storage } } }).jsdom;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    let present: unknown;
    try {
      present = (globalThis as Record<string, unknown>)[key];
    } catch {
      present = undefined;
    }
    if (present == null) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
  }
}
