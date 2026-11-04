/**
 * Keyboard handling: react-native-keyboard-controller follows the soft
 * keyboard frame by frame, so the composer rides on top of it with no jump.
 * Screens import these, never React Native's KeyboardAvoidingView.
 */
export { KeyboardAvoidingView, KeyboardProvider, KeyboardStickyView } from "react-native-keyboard-controller";
