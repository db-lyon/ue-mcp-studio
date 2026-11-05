/** biometric.ts on the web harness and in tests: no fingerprint reader, unless the visual QA page sets __qaBiometric. */
import type { BiometricUnlock } from "./biometric";
export type { BiometricUnlock } from "./biometric";
const NONE: BiometricUnlock = { available: false, enabled: false, unlock: async () => null, remember: async () => undefined, forget: async () => undefined };
export function useBiometricUnlock(_computerKey: string): BiometricUnlock {
  return (globalThis as { __qaBiometric?: BiometricUnlock }).__qaBiometric ?? NONE;
}
