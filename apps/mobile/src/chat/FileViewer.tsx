/**
 * chat/FileViewer.tsx: Studio's read-only file viewer at phone width, over
 * everything else. Markdown renders as a reply does, its links resolving
 * against the file; other text shows as numbered lines, scrolled to the line
 * a link named. System back returns to the file before, then closes.
 */
import { useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, type ScrollViewInstance, type ViewStyle } from "react-native";
import { FileViewer, fileLines, fileLinkTitle, type FileView } from "@ue-mcp-studio/client-core";
import { useBack } from "../back";
import { useProjectNav } from "../nav";
import { Button, font, useInsets, useStyles, type Theme } from "../ui";
import { FileFromContext, FileViewerContext } from "./FileLink";
import { ReplyMarkdown } from "./ReplyMarkdown";

/** The project's file viewer, reading through the agent, and its panel. */
export function FileViewerProvider({ children }: { children: ReactNode }) {
  const { api } = useProjectNav();
  const viewer = useMemo(() => new FileViewer((path) => api.readFile(path)), [api]);
  return (
    <FileViewerContext.Provider value={viewer}>
      {children}
      <FileViewerPanel viewer={viewer} />
    </FileViewerContext.Provider>
  );
}

function FileViewerPanel({ viewer }: { viewer: FileViewer }) {
  const { view, canGoBack } = useSyncExternalStore(viewer.subscribe, viewer.state);
  const s = useStyles(styles);
  const insets = useInsets();
  useBack(view ? () => (canGoBack ? viewer.back() : viewer.close()) : null, { overlay: true });
  if (!view) return null;
  const shown = view.status === "ready" ? view.file.path : view.request.path;
  const title = fileLinkTitle(shown, view.request.line);
  return (
    <Modal transparent animationType="none" visible statusBarTranslucent navigationBarTranslucent onRequestClose={() => (canGoBack ? viewer.back() : viewer.close())}>
      <View style={[s.backdrop, { paddingTop: 8 + insets.top, paddingBottom: 8 + insets.bottom, paddingLeft: 8 + insets.left, paddingRight: 8 + insets.right }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => viewer.close()} accessibilityLabel="Close the file" />
        <View style={s.panel} testID="file-viewer" role="dialog" aria-label={shown}>
          <View style={s.head}>
            {canGoBack ? <Button variant="ghost" title="Back" onPress={() => viewer.back()} /> : null}
            <Text style={s.path} numberOfLines={1} ellipsizeMode="head" accessibilityRole="header">
              {title}
            </Text>
            <Button variant="ghost" title="Close" onPress={() => viewer.close()} />
          </View>
          <FileBody key={`${shown}:${view.status}`} view={view} />
        </View>
      </View>
    </Modal>
  );
}

function FileBody({ view }: { view: FileView }) {
  const s = useStyles(styles);
  const scroll = useRef<ScrollViewInstance>(null);
  if (view.status === "loading") return <Text style={s.note}>Reading the file.</Text>;
  if (view.status === "error") return <Text style={[s.note, s.error]} accessibilityRole="alert">{view.error}</Text>;
  const { file } = view;
  return (
    <ScrollView ref={scroll} style={s.body} testID="file-viewer-body">
      {view.markdown ? (
        <FileFromContext.Provider value={file.path}>
          <ReplyMarkdown text={file.text} page />
        </FileFromContext.Provider>
      ) : (
        <NumberedLines text={file.text} line={view.request.line} onTarget={(y) => scroll.current?.scrollTo({ y: Math.max(0, y - 80), animated: false })} />
      )}
      {file.truncated ? <Text style={s.note}>{`Showing the first ${Math.round(file.text.length / 1024)} KB of ${Math.round(file.size / 1024)} KB.`}</Text> : null}
    </ScrollView>
  );
}

function NumberedLines({ text, line, onTarget }: { text: string; line?: number; onTarget: (y: number) => void }) {
  const s = useStyles(styles);
  const lines = useMemo(() => fileLines(text), [text]);
  return (
    <View>
      {lines.map((l, i) => (
        <View
          key={i}
          testID={i + 1 === line ? "file-line-current" : undefined}
          style={[s.line, i + 1 === line && s.current]}
          onLayout={i + 1 === line ? (e) => onTarget(e.nativeEvent.layout.y) : undefined}
        >
          <Text style={[s.mono, s.lineNo]} importantForAccessibility="no">{String(i + 1)}</Text>
          <Text style={[s.mono, s.lineText]} selectable>{l}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = (t: Theme) => ({
  backdrop: { flex: 1, backgroundColor: "rgba(0, 0, 0, 0.5)" },
  panel: { flex: 1, padding: 12, gap: 10, backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.editor ? "transparent" : t.c.line, borderRadius: t.radiusLg, boxShadow: "0 16px 48px rgba(0, 0, 0, 0.45)" } as ViewStyle,
  head: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
  path: { ...font(t, "mono", 500, 12.5, 1.4), color: t.c.text, flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  note: { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.muted, marginVertical: 8 },
  error: { color: t.c.bad },
  line: { flexDirection: "row" as const },
  current: { backgroundColor: t.c.accentWash },
  mono: { ...font(t, "mono", 400, 12), lineHeight: 18, color: t.c.text },
  lineNo: { width: 44, paddingRight: 10, textAlign: "right" as const, color: t.c.dim },
  lineText: { flex: 1, minWidth: 0 },
});
