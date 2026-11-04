/**
 * Share into Studio: an image, a file or text shared from another app arrives
 * here, for the open (or next picked) session to take as an attachment or as
 * the draft. ShareProvider goes at the root, before any other provider.
 */
import { useMemo, type ReactNode } from "react";
import { ShareIntentProvider, useShareIntentContext } from "expo-share-intent";

export interface SharedFile {
  uri: string;
  name: string;
  mimeType: string;
}

export interface Shared {
  files: SharedFile[];
  text: string | null;
  /** Drop what was shared, once it has been used. */
  consume(): void;
}

export function ShareProvider({ children }: { children: ReactNode }) {
  return <ShareIntentProvider options={{ resetOnBackground: false }}>{children}</ShareIntentProvider>;
}

export function useSharedFiles(): Shared {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  return useMemo(() => {
    if (!hasShareIntent) return { files: [], text: null, consume: () => undefined };
    const files = (shareIntent.files ?? []).map((f) => ({ uri: f.path.startsWith("file:") || f.path.startsWith("content:") ? f.path : `file://${f.path}`, name: f.fileName, mimeType: f.mimeType }));
    const text = shareIntent.webUrl ?? shareIntent.text ?? null;
    return { files, text: text && text.trim() ? text : null, consume: () => resetShareIntent() };
  }, [hasShareIntent, shareIntent, resetShareIntent]);
}
