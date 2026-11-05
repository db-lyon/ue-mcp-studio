/**
 * Haptic feedback on the actions that matter: a send, an answer, a scan, an
 * unlock, a wrong PIN. Silent where the device has no motor or the platform
 * has no haptics (the web harness).
 */
import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

const run = (f: () => Promise<void>) => {
  if (Platform.OS === "web") return;
  void f().catch(() => undefined);
};

export const haptic = {
  /** A light tap: sending, queueing, opening. */
  tap: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** A selection changed: a segment, a model, a checkbox. */
  select: () => run(() => Haptics.selectionAsync()),
  /** Something went through: an approval sent, a code scanned, unlocked. */
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Something to take care with: stopping a turn, a revert. */
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** Refused: a wrong PIN, a failed pairing. */
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
