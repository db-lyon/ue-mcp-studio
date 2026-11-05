/**
 * crypto.getRandomValues and randomUUID for Hermes, from the platform's secure
 * random source. Its own module, imported before the noble libraries, because
 * they read globalThis.crypto once when they load.
 */
import * as ExpoCrypto from "expo-crypto";

const g = globalThis as unknown as { crypto?: Record<string, unknown> };

if (!g.crypto?.getRandomValues) {
  const existing = g.crypto ?? {};
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: {
      ...existing,
      getRandomValues: <T extends ArrayBufferView>(a: T) => ExpoCrypto.getRandomValues(a as never) as T,
      randomUUID: () => ExpoCrypto.randomUUID(),
    },
  });
}
