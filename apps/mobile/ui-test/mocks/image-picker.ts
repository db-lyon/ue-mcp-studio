/** expo-image-picker for component tests: a test sets `next` to what the library or the camera hands back. */
export const picked: { next: unknown; camera: unknown; granted: boolean } = { next: { canceled: true, assets: null }, camera: { canceled: true, assets: null }, granted: true };
export const launchImageLibraryAsync = async () => picked.next;
export const launchCameraAsync = async () => picked.camera;
export const requestCameraPermissionsAsync = async () => ({ granted: picked.granted, canAskAgain: true });
