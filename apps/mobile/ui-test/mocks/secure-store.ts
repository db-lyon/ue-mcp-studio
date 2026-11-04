/** expo-secure-store in memory, for component tests. */
export const store = new Map<string, string>();
export const getItemAsync = async (k: string) => store.get(k) ?? null;
export const setItemAsync = async (k: string, v: string) => void store.set(k, v);
export const deleteItemAsync = async (k: string) => void store.delete(k);
