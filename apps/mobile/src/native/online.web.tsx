/** online.tsx on the web harness and in tests: online, unless the visual QA page sets __qaOffline. */
export function useDeviceOnline(): boolean {
  return !(globalThis as { __qaOffline?: boolean }).__qaOffline;
}
