/**
 * Project files a chat link names: GET /v1/ext/studio/files/read shows one in
 * Studio's file viewer, and POST /files/open opens one in the computer's
 * editor. Both routes reach the same files; open takes text types only.
 */

/** GET /v1/ext/studio/files/read?path=&from= */
export interface FileReadResponse {
  /** As shown: relative to the project, ../ above it, ~/ in the home folder. */
  path: string;
  text: string;
  /** The file's size in bytes. */
  size: number;
  /** The text stops at FILE_SHOW_BYTES. */
  truncated?: boolean;
}

/** Files larger than this are refused. */
export const FILE_READ_MAX_BYTES = 4 * 1024 * 1024;

/** The viewer shows at most this much of a file. */
export const FILE_SHOW_BYTES = 512 * 1024;

/**
 * Plain text types the system's editor may open. Anything that can run (a
 * script, a program, a shortcut) or that launches a tool (.uproject) is left out.
 */
const OPENABLE = new Set(["md", "markdown", "txt", "log", "json", "jsonc", "yml", "yaml", "toml", "ini", "cfg", "csv", "h", "hpp", "c", "cc", "cpp", "inl"]);

/** Whether POST /files/open will open this path in the system's editor. */
export function openableInEditor(path: string): boolean {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && OPENABLE.has(name.slice(dot + 1).toLowerCase());
}

/** Whether the viewer renders this file as markdown. */
export const isMarkdownPath = (path: string): boolean => /\.(md|markdown)$/i.test(path);
