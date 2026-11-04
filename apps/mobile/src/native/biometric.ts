// STUB: owned by the integrator (mobile/m1, apps/mobile/src/native/biometric.ts); replaced at merge.
/** A fingerprint releases the PIN kept in secure storage; the computer still checks it. */
export function useBiometricUnlock(_computerKey: string): {
  available: boolean;
  enabled: boolean;
  unlock(): Promise<string | null>;
  remember(pin: string): Promise<void> | void;
  forget(): Promise<void> | void;
} {
  return { available: false, enabled: false, unlock: async () => null, remember: () => undefined, forget: () => undefined };
}
