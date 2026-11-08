/**
 * chat/FileLink.tsx: a link to a project file, opening it in Studio's file
 * viewer. Inline text, so it wraps with the line it is in.
 */
import { createContext, useContext, type ReactNode } from "react";
import { Text } from "react-native";
import { fileLinkTitle, type FileViewer } from "@ue-mcp-studio/client-core";
import { useTheme } from "../ui";

/** The project's file viewer; null where none is mounted, and a file link is its text. */
export const FileViewerContext = createContext<FileViewer | null>(null);

/** The shown path of the file being viewed, so a link inside it resolves against it; undefined in the chat. */
export const FileFromContext = createContext<string | undefined>(undefined);

export function FileLink({ path, line, children }: { path: string; line?: number; children: ReactNode }) {
  const t = useTheme();
  const viewer = useContext(FileViewerContext);
  const from = useContext(FileFromContext);
  if (!viewer) return <>{children}</>;
  return (
    <Text
      accessibilityRole="link"
      accessibilityHint={fileLinkTitle(path, line)}
      style={{ color: t.c.accentHi, textDecorationLine: "underline", textDecorationColor: t.c.accentLine }}
      onPress={() => viewer.open({ path, line }, from)}
    >
      {children}
    </Text>
  );
}
