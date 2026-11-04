export const getRandomValues = <T extends ArrayBufferView>(a: T): T => globalThis.crypto.getRandomValues(a as never) as T;
export const randomUUID = () => globalThis.crypto.randomUUID();
