/** The system clipboard: Copy on a tool's result. */
import * as Clipboard from "expo-clipboard";

/** What text the clipboard holds, or "" when it holds none or cannot be read. */
export async function readText(): Promise<string> {
  try {
    return (await Clipboard.getStringAsync()) ?? "";
  } catch {
    return "";
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await Clipboard.setStringAsync(text);
    return true;
  } catch {
    return false;
  }
}
