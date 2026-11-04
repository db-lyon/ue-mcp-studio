// STUB: owned by the integrator (mobile/m1), who adds expo-image-picker@58.0.10 and
// expo-document-picker@58.0.4. Delete this file when they land: the packages' own types replace it.
declare module "expo-image-picker" {
  export interface ImagePickerAsset { uri: string; fileName?: string | null; mimeType?: string; fileSize?: number; base64?: string | null; width: number; height: number }
  export type ImagePickerResult = { canceled: true; assets: null } | { canceled: false; assets: ImagePickerAsset[] };
  export function launchImageLibraryAsync(options?: { mediaTypes?: Array<"images" | "videos" | "livePhotos">; allowsMultipleSelection?: boolean; base64?: boolean; quality?: number }): Promise<ImagePickerResult>;
}
declare module "expo-document-picker" {
  export interface DocumentPickerAsset { uri: string; name: string; mimeType?: string; size?: number; base64?: string }
  export type DocumentPickerResult = { canceled: true; assets: null } | { canceled: false; assets: DocumentPickerAsset[] };
  export function getDocumentAsync(options?: { type?: string | string[]; multiple?: boolean; copyToCacheDirectory?: boolean; base64?: boolean }): Promise<DocumentPickerResult>;
}
