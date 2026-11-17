import { createContext, useCallback, useEffect, useRef, useState } from "react";
import { ATTACHMENT_PART_BYTES, type Attachment } from "@ue-mcp-studio/shared";
import { MAX_BYTES, formatBytes, isImage } from "@ue-mcp-studio/client-core";
import { api } from "../api";

// The pure parts are client-core's, shared with the mobile app.
export { MAX_BYTES, attachmentUrl, formatBytes, isImage } from "@ue-mcp-studio/client-core";

/** The open session, for anything that links to its files. */
export const SessionIdContext = createContext<string | null>(null);

/** A file's bytes as base64, without the data URL prefix. */
export function readBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the file"));
    r.readAsDataURL(file);
  });
}

/** A file on its way into the next message. */
export interface PendingFile {
  key: string;
  name: string;
  type: string;
  size: number;
  /** A local preview for an image, until it is sent. */
  preview: string | null;
  state: "uploading" | "ready" | "error";
  error?: string;
  /** Bytes sent so far of a file that goes up in parts. */
  sent?: number;
  attachment?: Attachment;
}

let counter = 0;

/**
 * The files the user has added to the message they are writing: each one
 * uploads as soon as it is added, so Send only waits for the slow ones.
 */
export function useAttachments(sessionId: string | null) {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const live = useRef(files);
  live.current = files;

  const patch = (key: string, p: Partial<PendingFile>) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, ...p } : f)));

  /** The files themselves, kept while a chip is on screen so a failed upload can be sent again. */
  const sources = useRef(new Map<string, File>());

  /** Upload one file: whole when it fits one request, else read and sent a part at a time. */
  const upload = (key: string, file: File, name: string, type: string) => {
    const sid = sessionId;
    if (!sid) return;
    patch(key, { state: "uploading", error: undefined, sent: 0 });
    const done = file.size <= ATTACHMENT_PART_BYTES
      ? readBase64(file).then((data) => api.uploadAttachment(sid, { name, type, data }))
      : api.uploadAttachmentChunked(sid, { name, type, size: file.size }, (offset, length) => readBase64(file.slice(offset, offset + length)), (sent) => patch(key, { sent }));
    done.then((attachment) => patch(key, { state: "ready", attachment }), (e: Error) => patch(key, { state: "error", error: e.message }));
  };

  const add = useCallback((list: FileList | File[]) => {
    if (!sessionId) return;
    for (const file of Array.from(list)) {
      const key = `f${++counter}`;
      const type = file.type || "application/octet-stream";
      const pending: PendingFile = { key, name: file.name || "pasted file", type, size: file.size, preview: isImage(type) ? URL.createObjectURL(file) : null, state: "uploading" };
      setFiles((cur) => [...cur, pending]);
      if (file.size > MAX_BYTES) {
        patch(key, { state: "error", error: `larger than ${formatBytes(MAX_BYTES)}` });
        continue;
      }
      sources.current.set(key, file);
      upload(key, file, pending.name, type);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /** Send a failed file again, from its first part. */
  const retry = useCallback((key: string) => {
    const file = sources.current.get(key);
    const f = live.current.find((x) => x.key === key);
    if (file && f) upload(key, file, f.name, f.type);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  /** Drop every file that failed, so the message can go without them. */
  const removeFailed = useCallback(() => {
    setFiles((cur) => {
      for (const f of cur) if (f.state === "error") {
        if (f.preview) URL.revokeObjectURL(f.preview);
        sources.current.delete(f.key);
      }
      return cur.filter((f) => f.state !== "error");
    });
  }, []);

  const remove = useCallback((key: string) => {
    setFiles((cur) => {
      const f = cur.find((x) => x.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return cur.filter((x) => x.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    for (const f of live.current) if (f.preview) URL.revokeObjectURL(f.preview);
    sources.current.clear();
    setFiles([]);
  }, []);

  /** Empty the message's files and hand them over, previews kept, for a send that may fail and give them back. */
  const take = useCallback((): PendingFile[] => {
    const all = live.current;
    setFiles([]);
    return all;
  }, []);
  /** Put files a failed send took back in front of any added since. */
  const restore = useCallback((list: PendingFile[]) => setFiles((cur) => [...list, ...cur.filter((f) => !list.some((x) => x.key === f.key))]), []);
  /** A send went through: free the previews of the files it took. */
  const release = useCallback((list: PendingFile[]) => {
    for (const f of list) {
      if (f.preview) URL.revokeObjectURL(f.preview);
      sources.current.delete(f.key);
    }
  }, []);

  // Another session starts with nothing attached.
  useEffect(() => clear, [sessionId, clear]);

  return {
    files,
    add,
    remove,
    clear,
    take,
    restore,
    release,
    retry,
    removeFailed,
    /** Files that did not upload: Send waits for the user to retry or drop them, never leaves them out unannounced. */
    failed: files.filter((f) => f.state === "error").length,
    uploading: files.some((f) => f.state === "uploading"),
    ready: files.flatMap((f) => (f.state === "ready" && f.attachment ? [f.attachment] : [])),
  };
}
