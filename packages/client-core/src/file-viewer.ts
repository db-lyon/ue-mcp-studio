/**
 * Studio's read-only file viewer, the parts with no UI. Every client opens a
 * file link the same way: the viewer reads the file through the agent, and a
 * link inside a viewed file resolves against that file, with Back to return.
 */
import { isMarkdownPath, type FileReadResponse } from "@ue-mcp-studio/shared";
import { resolveFileLink } from "./links.js";

/** A file to show: path as the link wrote it, already resolved against the file it was followed from. */
export interface FileRequest {
  path: string;
  line?: number;
}

export type FileView =
  | { status: "loading"; request: FileRequest }
  | { status: "ready"; request: FileRequest; file: FileReadResponse; markdown: boolean }
  | { status: "error"; request: FileRequest; error: string };

export interface FileViewerState {
  /** The file on top, or null while the viewer is closed. */
  view: FileView | null;
  /** Whether Back returns to a file shown before this one. */
  canGoBack: boolean;
}

export type ReadFile = (path: string) => Promise<FileReadResponse>;

const CLOSED: FileViewerState = { view: null, canGoBack: false };

/** The viewer's files, newest on top; state() is the same object until it changes, as useSyncExternalStore needs. */
export class FileViewer {
  private stack: FileView[] = [];
  private snapshot: FileViewerState = CLOSED;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly read: ReadFile) {}

  state = (): FileViewerState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Show a file. from: the shown path of the viewed file the link is inside,
   * which keeps the files before it for Back; without it the viewer starts over.
   */
  open(target: FileRequest, from?: string): void {
    const request: FileRequest = { ...target, path: resolveFileLink(from, target.path) };
    const view: FileView = { status: "loading", request };
    this.stack = from ? [...this.stack, view] : [view];
    this.emit();
    this.read(request.path).then(
      (file) => this.settle(view, { status: "ready", request, file, markdown: isMarkdownPath(file.path) }),
      (e: unknown) => this.settle(view, { status: "error", request, error: e instanceof Error && e.message ? e.message : "Studio is not reachable." }),
    );
  }

  back(): void {
    if (this.stack.length < 2) return;
    this.stack = this.stack.slice(0, -1);
    this.emit();
  }

  close(): void {
    if (!this.stack.length) return;
    this.stack = [];
    this.emit();
  }

  /** A read answered: its entry takes the result, unless Back or Close dropped it meanwhile. */
  private settle(pending: FileView, done: FileView): void {
    const i = this.stack.indexOf(pending);
    if (i < 0) return;
    this.stack = this.stack.map((v, j) => (j === i ? done : v));
    this.emit();
  }

  private emit(): void {
    const top = this.stack[this.stack.length - 1];
    this.snapshot = top ? { view: top, canGoBack: this.stack.length > 1 } : CLOSED;
    for (const l of [...this.listeners]) l();
  }
}

/** A file's text as numbered lines; a final newline adds no empty line. */
export function fileLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

/** A file link's tooltip: the path, and the line when there is one. */
export const fileLinkTitle = (path: string, line?: number): string => (line ? `${path}:${line}` : path);
