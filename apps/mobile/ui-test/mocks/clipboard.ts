/** expo-clipboard in memory, for component tests and the parity page. A test sets `clip` to what the clipboard holds. */
export const clip: { text: string; image: { data: string; size: { width: number; height: number } } | null } = { text: "", image: null };
/** The last text copied. */
export let copied: string | null = null;
export const setStringAsync = async (text: string) => {
  copied = text;
  clip.text = text;
  return true;
};
export const getStringAsync = async () => clip.text;
export const hasStringAsync = async () => clip.text.length > 0;
export const hasImageAsync = async () => clip.image !== null;
export const getImageAsync = async (_o: { format: "png" | "jpeg" }) => clip.image;
