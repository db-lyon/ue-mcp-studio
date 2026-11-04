// STUB: owned by transcript
import { createContext } from "react";

export class AssetLinks {}

export const AssetLinksContext = createContext<AssetLinks | null>(null);
export const AssetTranscriptContext = createContext<readonly unknown[] | null>(null);

export function useAssetLinks(_sessionId: string | null): AssetLinks | null {
  return null;
}
