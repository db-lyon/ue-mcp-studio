/** expo-clipboard in memory, for component tests and the parity page. */
export let copied: string | null = null;
export const setStringAsync = async (text: string) => {
  copied = text;
  return true;
};
export const getStringAsync = async () => copied ?? "";
