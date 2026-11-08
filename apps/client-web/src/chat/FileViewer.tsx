import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openableInEditor } from "@ue-mcp-studio/shared";
import { FileViewer, fileLines, fileLinkTitle, type FileView } from "@ue-mcp-studio/client-core";
import { api } from "../api";
import { onRemotePage } from "../connection";
import { FileFromContext, FileViewerContext } from "./FileLink";
import { ReplyMarkdown } from "./ReplyMarkdown";

/** The page's file viewer, reading through the agent, and its panel over everything else. */
export function FileViewerProvider({ children }: { children: ReactNode }) {
  const viewer = useMemo(() => new FileViewer((path) => api.readFile(path)), []);
  return (
    <FileViewerContext.Provider value={viewer}>
      {children}
      <FileViewerPanel viewer={viewer} />
    </FileViewerContext.Provider>
  );
}

/**
 * A project file, read only: markdown as a reply renders it, with its links
 * resolving against the file; other text as numbered lines, scrolled to the
 * line a link named. On the computer a text file can also open in its editor.
 */
export function FileViewerPanel({ viewer }: { viewer: FileViewer }) {
  const { view, canGoBack } = useSyncExternalStore(viewer.subscribe, viewer.state);
  useEffect(() => {
    if (!view) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && viewer.close();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [view !== null, viewer]);
  if (!view) return null;
  const shown = view.status === "ready" ? view.file.path : view.request.path;
  return createPortal(
    <div className="overlay" onClick={() => viewer.close()}>
      <div className="overlay-card file-viewer" role="dialog" aria-label={shown} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head file-viewer-head">
          {canGoBack && <button className="ghost" onClick={() => viewer.back()}>Back</button>}
          <span className="file-viewer-path" title={fileLinkTitle(shown, view.request.line)}>{fileLinkTitle(shown, view.request.line)}</span>
          {view.status === "ready" && !onRemotePage() && openableInEditor(view.file.path) && <OpenInEditor path={view.file.path} />}
          <button className="ghost" onClick={() => viewer.close()}>Close</button>
        </div>
        <FileBody view={view} />
      </div>
    </div>,
    document.body,
  );
}

function FileBody({ view }: { view: FileView }) {
  if (view.status === "loading") return <p className="muted file-viewer-note">Reading the file.</p>;
  if (view.status === "error") return <p className="file-viewer-note bad" role="alert">{view.error}</p>;
  const { file } = view;
  const cut = file.truncated && <p className="muted file-viewer-note">Showing the first {Math.round(file.text.length / 1024)} KB of {Math.round(file.size / 1024)} KB.</p>;
  if (view.markdown) {
    return (
      <div className="file-viewer-body md">
        <FileFromContext.Provider value={file.path}><ReplyMarkdown text={file.text} /></FileFromContext.Provider>
        {cut}
      </div>
    );
  }
  return (
    <div className="file-viewer-body">
      <NumberedLines text={file.text} line={view.request.line} />
      {cut}
    </div>
  );
}

function NumberedLines({ text, line }: { text: string; line?: number }) {
  const lines = useMemo(() => fileLines(text), [text]);
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => target.current?.scrollIntoView?.({ block: "center" }), [text, line]);
  return (
    <pre className="file-lines">
      {lines.map((l, i) => (
        <div key={i} ref={i + 1 === line ? target : undefined} className={i + 1 === line ? "file-line current" : "file-line"}>
          <span className="file-line-no" aria-hidden="true">{i + 1}</span>
          <span className="file-line-text">{l || "\n"}</span>
        </div>
      ))}
    </pre>
  );
}

/** The file in the computer's own editor, the default app for its type. */
function OpenInEditor({ path }: { path: string }) {
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setError(null);
    api.openFile(path).catch((e: Error) => setError(e.message));
  };
  return (
    <>
      {error && <span className="file-viewer-error bad" role="alert">{error}</span>}
      <button className="ghost" onClick={open} title={`Open ${path} in its default app`}>Open in editor</button>
    </>
  );
}
