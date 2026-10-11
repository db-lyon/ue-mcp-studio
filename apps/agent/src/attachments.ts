/**
 * Files the user drops or pastes into a message. Each is saved under the
 * session's folder in the extension's data dir, so the agent can also import
 * it into the project through ue-mcp by its path. What the model is given
 * depends on the kind: an image or a PDF as itself, a text file as its text,
 * anything else (meshes, audio, video, packages) as its path alone.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Attachment, AttachmentUpload } from "@ue-mcp-studio/shared";

/** The largest file the panel accepts. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** The model API's limit for one image. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The model API's limit for one PDF. */
const MAX_PDF_BYTES = 32 * 1024 * 1024;
/** Text files larger than this go in by path, not inline. */
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".csv", ".tsv", ".xml", ".yml", ".yaml", ".ini", ".log", ".cfg", ".toml",
  ".py", ".js", ".ts", ".tsx", ".jsx", ".cpp", ".c", ".h", ".hpp", ".cs", ".usf", ".ush", ".hlsl", ".glsl",
  ".uproject", ".uplugin", ".html", ".css", ".sh", ".bat", ".ps1",
]);

/** A file name safe to keep on disk: its base name, without characters Windows refuses. */
export function safeName(name: string): string {
  // The last segment of either kind of path; path.basename would read "a:" as a Windows drive.
  const base = (name.replace(/\\/g, "/").split("/").pop() ?? "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (base || "file").slice(0, 120);
}

const isText = (a: Attachment): boolean =>
  a.type.startsWith("text/") || /json|xml|yaml|javascript/.test(a.type) || TEXT_EXTENSIONS.has(path.extname(a.name).toLowerCase());

export class AttachmentStore {
  constructor(private readonly dataDir: string) {}

  private dir(sessionId: string): string {
    return path.join(this.dataDir, "attachments", sessionId.replace(/[^\w-]/g, "_"));
  }

  save(sessionId: string, upload: AttachmentUpload): Attachment & { path: string } {
    if (typeof upload?.name !== "string" || typeof upload.data !== "string") throw new Error("body must be { name, type, data (base64) }");
    const bytes = Buffer.from(upload.data, "base64");
    if (bytes.length === 0) throw new Error(`${upload.name} is empty`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${upload.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    const id = crypto.randomUUID();
    const a: Attachment = { id, name: safeName(upload.name), type: typeof upload.type === "string" && upload.type ? upload.type : "application/octet-stream", size: bytes.length };
    const dir = this.dir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}-${a.name}`);
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(a));
    return { ...a, path: file };
  }

  get(sessionId: string, id: string): (Attachment & { path: string }) | null {
    if (!/^[0-9a-f-]{36}$/.test(id)) return null;
    try {
      const dir = this.dir(sessionId);
      const a = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), "utf-8")) as Attachment;
      const file = path.join(dir, `${id}-${a.name}`);
      return fs.existsSync(file) ? { ...a, path: file } : null;
    } catch {
      return null;
    }
  }

  /** Every file of a deleted session. */
  removeSession(sessionId: string): void {
    fs.rmSync(this.dir(sessionId), { recursive: true, force: true });
  }
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** What the model gets for one attachment: a line naming the file and its path, and the file itself when it can read it. */
export function contentFor(a: Attachment & { path: string }): unknown[] {
  const note = (how: string) => ({
    type: "text",
    text: `[Attached file] ${a.name} (${a.type}, ${kb(a.size)}), saved at ${a.path}. ${how}`,
  });
  if (IMAGE_TYPES.has(a.type) && a.size <= MAX_IMAGE_BYTES) {
    return [note("The image follows; import it with ue-mcp if the task needs it in the project."), {
      type: "image",
      source: { type: "base64", media_type: a.type, data: fs.readFileSync(a.path).toString("base64") },
    }];
  }
  if (a.type === "application/pdf" && a.size <= MAX_PDF_BYTES) {
    return [note("The document follows."), {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: fs.readFileSync(a.path).toString("base64") },
    }];
  }
  if (isText(a) && a.size <= MAX_INLINE_TEXT_BYTES) {
    return [note("Its text follows."), { type: "text", text: fs.readFileSync(a.path, "utf-8") }];
  }
  return [note("You cannot read this kind of file directly; import it into the project with ue-mcp if the task needs it.")];
}
