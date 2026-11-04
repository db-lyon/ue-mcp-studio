/** expo-image-picker for component tests: a test sets `next` to what the library hands back. */
export const picked: { next: unknown } = { next: { canceled: true, assets: null } };
export const launchImageLibraryAsync = async () => picked.next;
