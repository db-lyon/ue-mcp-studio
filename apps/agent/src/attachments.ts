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
import { MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentUpload } from "@ue-mcp-studio/shared";
import { imageBlock, prepareImage, sniffImage } from "./images.js";

export { MAX_ATTACHMENT_BYTES };
/** Images larger than this go in by path: reading and decoding one whole is for the shell to shrink first. */
const MAX_INLINE_IMAGE_BYTES = 50 * 1024 * 1024;
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

  /** Give another session its own copy of a session's files, ids unchanged, as a fork needs. */
  copy(from: string, to: string): void {
    if (fs.existsSync(this.dir(from))) fs.cpSync(this.dir(from), this.dir(to), { recursive: true });
  }

  /**
   * One upload: a whole file, or one part of one sent in several. A part that
   * is not the last is appended to the file being gathered and answers null;
   * the last keeps the whole file.
   */
  save(sessionId: string, upload: AttachmentUpload): (Attachment & { path: string }) | null {
    if (typeof upload?.name !== "string" || typeof upload.data !== "string") throw new Error("body must be { name, type, data (base64) }");
    if (upload.part !== undefined) return this.savePart(sessionId, upload);
    const bytes = Buffer.from(upload.data, "base64");
    if (bytes.length === 0) throw new Error(`${upload.name} is empty`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error(`${upload.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    return this.keep(sessionId, upload.name, typeof upload.type === "string" && upload.type ? upload.type : "application/octet-stream", bytes);
  }

  private savePart(sessionId: string, upload: AttachmentUpload): (Attachment & { path: string }) | null {
    const p = upload.part!;
    if (typeof p.id !== "string" || !/^[\w-]{8,64}$/.test(p.id) || !Number.isInteger(p.index) || p.index < 0 || typeof p.last !== "boolean") {
      throw new Error("part must be { id, index, last }");
    }
    const dir = this.dir(sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const gathering = path.join(dir, `${p.id}.part`);
    const record = path.join(dir, `${p.id}.part.json`);
    const had = p.index === 0 ? 0 : (() => {
      try {
        return (JSON.parse(fs.readFileSync(record, "utf-8")) as { next: number }).next;
      } catch {
        return -1;
      }
    })();
    if (p.index === 0) fs.rmSync(gathering, { force: true });
    else if (had !== p.index) throw new Error(`part ${p.index} of ${upload.name} came out of order; send the file again`);
    const bytes = Buffer.from(upload.data, "base64");
    fs.appendFileSync(gathering, bytes);
    const size = fs.statSync(gathering).size;
    if (size > MAX_ATTACHMENT_BYTES) {
      fs.rmSync(gathering, { force: true });
      fs.rmSync(record, { force: true });
      throw new Error(`${upload.name} is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
    }
    if (!p.last) {
      fs.writeFileSync(record, JSON.stringify({ next: p.index + 1 }));
      return null;
    }
    fs.rmSync(record, { force: true });
    if (size === 0) {
      fs.rmSync(gathering, { force: true });
      throw new Error(`${upload.name} is empty`);
    }
    const id = crypto.randomUUID();
    const a: Attachment = { id, name: safeName(upload.name), type: typeof upload.type === "string" && upload.type ? upload.type : "application/octet-stream", size };
    const file = path.join(dir, `${id}-${a.name}`);
    fs.renameSync(gathering, file);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(a));
    return { ...a, path: file };
  }

  /** Keep bytes as one of the session's files: an upload, or an image a tool showed the model. */
  keep(sessionId: string, name: string, type: string, bytes: Buffer): Attachment & { path: string } {
    const id = crypto.randomUUID();
    const a: Attachment = { id, name: safeName(name), type, size: bytes.length };
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

/** What the model gets for one attachment: a line naming the file and its path, and the file itself when it can read it. A large image is scaled to fit. */
export async function contentFor(a: Attachment & { path: string }): Promise<unknown[]> {
  const note = (how: string) => ({
    type: "text",
    text: `[Attached file] ${a.name} (${a.type}, ${kb(a.size)}), saved at ${a.path}. ${how}`,
  });
  if (IMAGE_TYPES.has(a.type) && a.size > MAX_INLINE_IMAGE_BYTES) {
    return [note("It is too large an image to show here; make a smaller copy with the shell (for example with ImageMagick or ffmpeg), then read the copy with read_file.")];
  }
  if (IMAGE_TYPES.has(a.type)) {
    const bytes = fs.readFileSync(a.path);
    const type = sniffImage(bytes);
    if (type) {
      try {
        const img = await prepareImage(bytes, type);
        const how = img.original ? `It follows as a ${img.width}x${img.height} copy, scaled to fit the model's image limits` : "The image follows";
        return [note(`${how}; import the file with ue-mcp if the task needs it in the project.`), imageBlock(img)];
      } catch {
        // Not decodable: offered by path below.
      }
    }
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
  // Too large to inline, but still readable: say how, rather than that it cannot be read.
  if (isText(a)) return [note("It is too long to include whole; read it from that path with read_file (offset and limit) or search it with grep.")];
  if (a.type === "application/pdf") return [note("It is larger than the model takes as a document; extract its text or split it with the shell, then read the parts.")];
  return [note("You cannot read this kind of file directly; import it into the project with ue-mcp if the task needs it.")];
}
