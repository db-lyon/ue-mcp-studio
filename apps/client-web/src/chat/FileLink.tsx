import { createContext, useContext, type ReactNode } from "react";
import { fileLinkTitle, type FileViewer } from "@ue-mcp-studio/client-core";

/** The page's file viewer; null where none is mounted, and a file link is its text. */
export const FileViewerContext = createContext<FileViewer | null>(null);

/** The shown path of the file being viewed, so a link inside it resolves against it; undefined in the chat. */
export const FileFromContext = createContext<string | undefined>(undefined);

/** A link to a project file: opens it in Studio's file viewer, at its line when it has one. */
export function FileLink({ path, line, children }: { path: string; line?: number; children: ReactNode }) {
  const viewer = useContext(FileViewerContext);
  const from = useContext(FileFromContext);
  if (!viewer) return <>{children}</>;
  return (
    <button type="button" className="asset-link file-link" title={fileLinkTitle(path, line)} onClick={() => viewer.open({ path, line }, from)}>
      {children}
    </button>
  );
}
