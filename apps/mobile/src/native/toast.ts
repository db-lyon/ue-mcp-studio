/** The system's own short toast where it has one (Android); false where the app draws its own. */
import { Platform, ToastAndroid } from "react-native";

export function systemToast(text: string): boolean {
  if (Platform.OS !== "android") return false;
  ToastAndroid.show(text, ToastAndroid.SHORT);
  return true;
}
