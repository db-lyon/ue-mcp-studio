/**
 * Whether the soft keyboard is up, from react-native-keyboard-controller. The
 * chat's KeyboardAvoidingView lifts the composer frame by frame; the composer
 * only drops its safe-area bottom padding while the keyboard covers that area,
 * so it sits on the keyboard with no gap and no jump.
 */
import { useKeyboardState } from "react-native-keyboard-controller";

export const useKeyboardOpen = (): boolean => useKeyboardState((s) => s.isVisible);
