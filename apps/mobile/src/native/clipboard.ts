/** The system clipboard: Copy on a tool's result. */
import * as Clipboard from "expo-clipboard";

export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
