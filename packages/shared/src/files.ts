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

// ── Images ──────────────────────────────────────────────────────

/** Image types GET /v1/ext/studio/files/image serves from the project, by extension. */
export const PROJECT_IMAGE_TYPES: Readonly<Record<string, string>> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

/** Images larger than this are refused. */
export const IMAGE_READ_MAX_BYTES = 25 * 1024 * 1024;

/** The image type of a project path by its extension, or null for anything else. */
export function projectImageType(path: string): string | null {
  const m = /\.([a-z0-9]+)$/i.exec(path.split(/[?#]/)[0]);
  return m ? PROJECT_IMAGE_TYPES[m[1].toLowerCase()] ?? null : null;
}

/**
 * A markdown image in a reply that names a file on this computer (a project
 * path, an absolute path or file://), which the chat shows through
 * /files/image; null for a web image or anything that is not an image file.
 */
export function localImagePath(src: string | undefined | null): string | null {
  if (!src) return null;
  if (/^(https?|data|blob):/i.test(src)) return null;
  const p = src.replace(/^file:\/\/\/?/i, "");
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    // Left as written.
  }
  return projectImageType(decoded) ? decoded : null;
}

/** GET /v1/ext/studio/files/image?path= for a project image. */
export const projectImageUrl = (path: string): string => `/v1/ext/studio/files/image?path=${encodeURIComponent(path)}`;

/**
 * GET /v1/ext/studio/files/image?path=&poster=1: the image's first frame as a
 * small JPEG, made once by the daemon and kept, so a chat draws something
 * within a second while the whole file (an 11 MB capture GIF) still loads.
 */
export const projectImagePosterUrl = (path: string): string => `${projectImageUrl(path)}&poster=1`;

/** The longest side of a poster. */
export const POSTER_EDGE = 480;
/** The most bytes a poster is kept at; it is made smaller until it fits. */
export const POSTER_MAX_BYTES = 48 * 1024;
/** Images smaller than this get no poster: the whole file arrives about as fast. */
export const POSTER_MIN_BYTES = 160 * 1024;

/**
 * What the daemon knows of an image a reply shows, sent with the reply so a
 * chat can draw the picture's tile at its final size before any byte of it
 * has arrived. Read from the file's header when the reply is written.
 */
export interface ReplyImageInfo {
  /** Its MIME type, from its first bytes. */
  type: string;
  width: number;
  height: number;
  /** The file's size. */
  bytes: number;
  /** Frames it holds: 1 for a still. */
  frames: number;
  /** It plays: a GIF, WebP or PNG with more than one frame. */
  animated: boolean;
  /** GET projectImagePosterUrl(path) answers with its first frame; absent when it is small enough to load whole. */
  poster?: boolean;
}

/**
 * The project images a reply's markdown shows, as localImagePath reads each
 * `![caption](src)`: the keys of an assistant entry's `images`. A web image
 * is left out, and each path appears once.
 */
export function replyImagePaths(text: string): string[] {
  const out: string[] = [];
  const re = /!\[(?:[^\]\\]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const local = localImagePath(m[1] ?? m[2]);
    if (local && !out.includes(local)) out.push(local);
  }
  return out;
}
