/** keyboard.ts on the web harness and in tests: up only when a test puts the stand-in keyboard up. */
import { useKeyboardHeight } from "../../../native/keyboard";

export const useKeyboardOpen = (): boolean => useKeyboardHeight() > 0;
