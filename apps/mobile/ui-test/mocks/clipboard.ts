/** expo-clipboard for component tests and the parity page: a test sets `clip` to what the clipboard holds. */
export const clip: { text: string; image: { data: string; size: { width: number; height: number } } | null } = { text: "", image: null };
export const setStringAsync = async (text: string) => {
  clip.text = text;
  return true;
};
export const getStringAsync = async () => clip.text;
export const hasStringAsync = async () => clip.text.length > 0;
export const hasImageAsync = async () => clip.image !== null;
export const getImageAsync = async (_o: { format: "png" | "jpeg" }) => clip.image;
