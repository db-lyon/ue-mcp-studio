/**
 * Keyboard handling: react-native-keyboard-controller follows the soft
 * keyboard frame by frame, so the composer rides on top of it with no jump.
 * Screens import these, never React Native's KeyboardAvoidingView.
 */
import { useKeyboardState } from "react-native-keyboard-controller";

export { KeyboardAvoidingView, KeyboardProvider } from "react-native-keyboard-controller";

/** How far the soft keyboard reaches up from the bottom of the screen, 0 while it is down. */
export const useKeyboardHeight = (): number => useKeyboardState((s) => (s.isVisible ? s.height : 0));
