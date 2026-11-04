/** expo-document-picker for component tests: a test sets `next` to what the picker hands back. */
export const picked: { next: unknown } = { next: { canceled: true, assets: null } };
export const getDocumentAsync = async () => picked.next;
