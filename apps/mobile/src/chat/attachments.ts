/**
 * The files added to the message being written: each uploads as soon as it is
 * added, so Send only waits for the slow ones. A phone hands files over as a
 * picked or shared file (a uri) or as bytes already read (base64).
 */
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "@ue-mcp-studio/shared";
import { attachmentUrl, formatBytes, isImage, MAX_BYTES } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";

export { attachmentUrl, formatBytes, isImage, MAX_BYTES };

/** The open session, for anything that links to its files. */
export const SessionIdContext = createContext<string | null>(null);

/** A file the phone hands over: a picker's or another app's (uri), or bytes already read (data, base64). */
export interface PickedFile {
  name: string;
  type?: string;
  size?: number;
  uri?: string;
  data?: string;
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

/** A picked file's bytes as base64, without a data URL prefix. */
export async function readBase64(file: PickedFile): Promise<string> {
  if (file.data !== undefined) return file.data.replace(/^data:[^,]*,/, "");
  if (!file.uri) throw new Error("the file has no contents");
  // A local file the picker or the share sheet handed over, never the daemon.
  const blob = await (await fetch(file.uri)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("could not read the file"));
    r.readAsDataURL(blob);
  });
}

const sizeOf = (f: PickedFile): number => f.size ?? (f.data ? Math.floor((f.data.length * 3) / 4) : 0);

let counter = 0;

export function useAttachments(sessionId: string | null) {
  const { api } = useProjectNav();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const live = useRef(files);
  live.current = files;

  const patch = (key: string, p: Partial<PendingFile>) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const add = useCallback(
    (list: PickedFile[]) => {
      if (!sessionId) return;
      for (const file of list) {
        const key = `f${++counter}`;
        const type = file.type || "application/octet-stream";
        const size = sizeOf(file);
        const preview = isImage(type) ? (file.uri ?? (file.data ? `data:${type};base64,${file.data}` : null)) : null;
        const pending: PendingFile = { key, name: file.name || "pasted file", type, size, preview, state: "uploading" };
        setFiles((cur) => [...cur, pending]);
        if (size > MAX_BYTES) {
          patch(key, { state: "error", error: `larger than ${formatBytes(MAX_BYTES)}` });
          continue;
        }
        readBase64(file)
          .then((data) => api.uploadAttachment(sessionId, { name: pending.name, type, data }))
          .then((attachment) => patch(key, { state: "ready", attachment }), (e: Error) => patch(key, { state: "error", error: e.message }));
      }
    },
    [sessionId, api],
  );

  const remove = useCallback((key: string) => setFiles((cur) => cur.filter((x) => x.key !== key)), []);
  const clear = useCallback(() => setFiles([]), []);

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
