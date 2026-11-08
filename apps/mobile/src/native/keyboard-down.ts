/**
 * Keeping the soft keyboard down while a screen that takes no typing covers
 * the app (the PIN lock): the app under it stays mounted, so a text box there
 * that kept the focus would hold the keyboard up, and Android raises it again
 * for that box when the app comes back to the front.
 */
import { useEffect } from "react";
import { AppState, Keyboard, TextInput } from "react-native";

/** Blurs whatever text box has the focus and puts the soft keyboard away. */
export function keyboardAway(): void {
  const State = (TextInput as unknown as { State?: { currentlyFocusedInput?: () => { blur?: () => void } | null } }).State;
  State?.currentlyFocusedInput?.()?.blur?.();
  Keyboard.dismiss();
}

/** While mounted: the keyboard is put away on arrival, whenever it shows, and whenever the app comes back. */
export function useKeyboardDown(): void {
  useEffect(() => {
    keyboardAway();
    const shown = Keyboard.addListener("keyboardDidShow", keyboardAway);
    const app = AppState.addEventListener("change", (state) => state === "active" && keyboardAway());
    return () => {
      shown.remove();
      app.remove();
    };
  }, []);
}
