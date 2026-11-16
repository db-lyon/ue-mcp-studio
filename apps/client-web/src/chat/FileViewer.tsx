import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { openableInEditor, projectImageType, projectImageUrl } from "@ue-mcp-studio/shared";
import { FILE_REFUSED_REMOTE, FileViewer, OPEN_IN_EDITOR_REMOTE, fileLines, fileLinkTitle, rawFileNote, type FileView } from "@ue-mcp-studio/client-core";
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
          {view.status === "ready" && onRemotePage() && openableInEditor(view.file.path) && <RawFile file={view.file} />}
          <button className="ghost" onClick={() => viewer.close()}>Close</button>
        </div>
        <FileBody view={view} />
      </div>
    </div>,
    document.body,
  );
}

/**
 * A file the viewer could not show as text: an image shows as itself; on the
 * computer anything else can be shown in its folder, and a text type opened
 * in its editor. Never a bare refusal.
 */
function FileRefused({ view }: { view: Extract<FileView, { status: "error" }> }) {
  const path = view.request.path;
  const [failed, setFailed] = useState<string | null>(null);
  if (projectImageType(path)) {
    return (
      <div className="file-viewer-body">
        <img className="file-viewer-image" src={projectImageUrl(path)} alt={path} />
      </div>
    );
  }
  const remote = onRemotePage();
  return (
    <div className="file-viewer-note">
      <p className="bad" role="alert">{view.error}</p>
      {remote ? (
        <p className="muted">{FILE_REFUSED_REMOTE}</p>
      ) : (
        <p className="row">
          <button onClick={() => api.revealFile(path).catch((e: Error) => setFailed(e.message))}>Show in folder</button>
          {openableInEditor(path) && <OpenInEditor path={path} />}
        </p>
      )}
      {failed && <p className="bad" role="alert">{failed}</p>}
    </div>
  );
}

function FileBody({ view }: { view: FileView }) {
  if (view.status === "loading") return <p className="muted file-viewer-note">Reading the file.</p>;
  if (view.status === "error") return <FileRefused view={view} />;
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

/**
 * On a paired browser, in place of Open in editor, which opens on the computer:
 * says so, and saves the file's text here.
 */
export function RawFile({ file }: { file: { path: string; text: string; truncated?: boolean } }) {
  const save = () => {
    const url = URL.createObjectURL(new Blob([file.text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = file.path.split("/").pop() || "file.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <span className="dim small" title={OPEN_IN_EDITOR_REMOTE}>{OPEN_IN_EDITOR_REMOTE}</span>
      <button className="ghost" onClick={save} title={rawFileNote(!!file.truncated)}>Save a copy</button>
    </>
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
