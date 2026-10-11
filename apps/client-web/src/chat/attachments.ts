import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@ue-mcp-studio/shared";
import { api } from "../api";

/** The open session, for anything that links to its files. */
export const SessionIdContext = createContext<string | null>(null);

export const attachmentUrl = (sessionId: string, id: string): string =>
  `/v1/ext/studio/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`;

export const isImage = (type: string): boolean => /^image\/(png|jpeg|gif|webp)$/.test(type);

/** 3 KB, 1.2 MB. */
export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The largest file the agent accepts; matches MAX_ATTACHMENT_BYTES there. */
export const MAX_BYTES = 100 * 1024 * 1024;

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
      readBase64(file)
        .then((data) => api.uploadAttachment(sessionId, { name: pending.name, type, data }))
        .then((attachment) => patch(key, { state: "ready", attachment }), (e: Error) => patch(key, { state: "error", error: e.message }));
    }
  }, [sessionId]);

  const remove = useCallback((key: string) => {
    setFiles((cur) => {
      const f = cur.find((x) => x.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return cur.filter((x) => x.key !== key);
    });
  }, []);

  const clear = useCallback(() => {
    for (const f of live.current) if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles([]);
  }, []);

  // Another session starts with nothing attached.
  useEffect(() => clear, [sessionId, clear]);

  return {
    files,
    add,
    remove,
    clear,
    uploading: files.some((f) => f.state === "uploading"),
    ready: files.flatMap((f) => (f.state === "ready" && f.attachment ? [f.attachment] : [])),
  };
}
