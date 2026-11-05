/**
 * Fingerprint or face unlock, as a convenience over the computer's PIN: the
 * PIN is kept in the secure store under a key the platform releases only after
 * a biometric check, and is then sent like a typed one. The computer still
 * checks it, so a PIN changed on the computer just fails once and is forgotten.
 */
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

/** Secure store keys allow [A-Za-z0-9._-]; a computer key is base64url, which fits once trimmed. */
const slot = (computerKey: string) => `pin.${computerKey.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40)}`;
const flag = (computerKey: string) => `${slot(computerKey)}.on`;

export interface BiometricUnlock {
  /** The device has a fingerprint or face enrolled. */
  available: boolean;
  /** The owner chose to unlock this computer with it, and a PIN is kept. */
  enabled: boolean;
  /** Asks for the fingerprint; the kept PIN, or null when cancelled or failed. */
  unlock(): Promise<string | null>;
  /** Keeps the PIN behind the fingerprint. */
  remember(pin: string): Promise<void>;
  forget(): Promise<void>;
}

export function useBiometricUnlock(computerKey: string): BiometricUnlock {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (Platform.OS === "web") return;
    let live = true;
    void (async () => {
      const can = (await LocalAuthentication.hasHardwareAsync().catch(() => false)) && (await LocalAuthentication.isEnrolledAsync().catch(() => false));
      const on = (await SecureStore.getItemAsync(flag(computerKey)).catch(() => null)) === "1";
      if (live) {
        setAvailable(can);
        setEnabled(can && on);
      }
    })();
    return () => void (live = false);
  }, [computerKey]);

  const forget = useCallback(async () => {
    await SecureStore.deleteItemAsync(slot(computerKey)).catch(() => undefined);
    await SecureStore.deleteItemAsync(flag(computerKey)).catch(() => undefined);
    setEnabled(false);
  }, [computerKey]);

  const remember = useCallback(
    async (pin: string) => {
      await SecureStore.setItemAsync(slot(computerKey), pin, { requireAuthentication: true, authenticationPrompt: "Use your fingerprint to unlock Studio" });
      await SecureStore.setItemAsync(flag(computerKey), "1");
      setEnabled(true);
    },
    [computerKey],
  );

  const unlock = useCallback(async () => {
    try {
      return await SecureStore.getItemAsync(slot(computerKey), { requireAuthentication: true, authenticationPrompt: "Unlock Studio" });
    } catch {
      // Cancelled, too many tries, or the fingerprints changed (the key is then gone for good).
      return null;
    }
  }, [computerKey]);

  return { available, enabled, unlock, remember, forget };
}
