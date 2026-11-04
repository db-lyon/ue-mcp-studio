/** Small stand-ins for Expo modules the screens import, for the web harness and component tests. */
export default { expoConfig: { version: "0.2.0" } };
export const expoConfig = { version: "0.2.0" };
export const nativeApplicationVersion = "0.2.0";
export const nativeBuildVersion = "6";
export const applicationId = "com.uemcp.studio.remote";
export const MediaTypeOptions = { Images: "images" };
export async function launchImageLibraryAsync() {
  return { canceled: true, assets: [] };
}
export async function launchCameraAsync() {
  return { canceled: true, assets: [] };
}
export async function requestMediaLibraryPermissionsAsync() {
  return { granted: true };
}
export async function getDocumentAsync() {
  return { canceled: true, assets: [] };
}
