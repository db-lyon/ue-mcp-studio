/**
 * The few runtime globals this package uses, which browsers, Node and React
 * Native all provide. Declared here instead of pulling in the DOM library, so
 * nothing DOM-only can creep into shared code.
 */
declare global {
  interface AbortSignal {
    readonly aborted: boolean;
    addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
    removeEventListener(type: "abort", listener: () => void): void;
  }
  // eslint-disable-next-line no-var
  var AbortController: { new (): { readonly signal: AbortSignal; abort(): void } };
  // eslint-disable-next-line no-var
  var TextDecoder: { new (label?: string): { decode(input?: Uint8Array, options?: { stream?: boolean }): string } };
  function setTimeout(fn: () => void, ms?: number): unknown;
  function clearTimeout(handle: unknown): void;
}

export {};
