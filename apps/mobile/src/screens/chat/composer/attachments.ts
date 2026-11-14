/**
 * The web client's chat/attachments.ts for the app: files picked from the
 * phone (its photos, the camera, any file, an image on the clipboard) or shared
 * to the app, each uploaded as soon as it is added through the same route the
 * web client uses.
 */
import { createContext, useCallback, useEffect, useRef, useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Clipboard from "expo-clipboard";
import { MAX_BYTES, formatBytes, isImage } from "@ue-mcp-studio/client-core";
import type { Attachment } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../../nav";

export { MAX_BYTES, attachmentUrl, formatBytes, isImage } from "@ue-mcp-studio/client-core";

/** The open session, for anything that links to its files. */
export const SessionIdContext = createContext<string | null>(null);

/** A file from the phone: the app's form of a browser File. `base64` when the picker read it already. */
export interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size: number;
  base64?: string | null;
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

/** Where Attach takes a file from. */
export type PickSource = "images" | "camera" | "files";

/** Thrown when the camera may not be used: the sheet says so instead of the picker opening. */
export const CAMERA_REFUSED = "Studio may not use the camera. Allow it in the phone's settings.";

type ImageAsset = { uri: string; fileName?: string | null; mimeType?: string | null; fileSize?: number | null; base64?: string | null };
const fromImage = (a: ImageAsset, i: number, stem: string): PickedFile => ({
  uri: a.uri,
  name: a.fileName || `${stem}-${i + 1}.${(a.mimeType ?? "image/jpeg").split("/")[1]}`,
  type: a.mimeType ?? "image/jpeg",
  size: a.fileSize ?? Math.round(((a.base64?.length ?? 0) * 3) / 4),
  base64: a.base64,
});

/** Photos from the library, a photo taken now, or any file from the phone's files. Empty when the user backs out. */
export async function pickFiles(from: PickSource): Promise<PickedFile[]> {
  if (from === "images") {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, base64: true, quality: 1 });
    if (r.canceled) return [];
    return r.assets.map((a, i) => fromImage(a, i, "photo"));
  }
  if (from === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) throw new Error(CAMERA_REFUSED);
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], base64: true, quality: 0.9 });
    if (r.canceled) return [];
    return r.assets.map((a, i) => fromImage(a, i, "camera"));
  }
  const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true, type: "*/*" });
  if (r.canceled) return [];
  return r.assets.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType ?? "application/octet-stream", size: a.size ?? 0, base64: a.base64 }));
}

/**
 * An image on the clipboard, as a file: the phone's form of pasting a
 * screenshot into the box. Text on the clipboard stays text (the box pastes it
 * itself), so this is empty when there is no image.
 */
export async function pastedImage(): Promise<PickedFile[]> {
  if (!(await Clipboard.hasImageAsync())) return [];
  const image = await Clipboard.getImageAsync({ format: "png" });
  if (!image) return [];
  const base64 = image.data.replace(/^data:[^,]*,/, "");
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return [{ uri: image.data.startsWith("data:") ? image.data : `data:image/png;base64,${base64}`, name: `pasted-${stamp}.png`, type: "image/png", size: Math.round((base64.length * 3) / 4), base64 }];
}

/** Whether the clipboard holds an image, for Paste image in the Attach sheet. */
export const clipboardHasImage = (): Promise<boolean> => Clipboard.hasImageAsync().catch(() => false);

/** A picked file's bytes as base64: the picker's own when it read them, else read from its local uri. */
export async function readBase64(file: PickedFile): Promise<string> {
  if (file.base64) return file.base64;
  // A local file: content:// or file:// on the phone, never the daemon.
  const blob = await (await fetch(file.uri)).blob();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(new Error("could not read the file"));
    r.readAsDataURL(blob);
  });
}

let counter = 0;

/**
 * The files the user has added to the message they are writing: each one
 * uploads as soon as it is added, so Send only waits for the slow ones.
 */
export function useAttachments(sessionId: string | null) {
  const { api } = useProjectNav();
  const [files, setFiles] = useState<PendingFile[]>([]);
  const live = useRef(files);
  live.current = files;

  const patch = (key: string, p: Partial<PendingFile>) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, ...p } : f)));

  const add = useCallback((list: PickedFile[]) => {
    if (!sessionId) return;
    for (const file of list) {
      const key = `f${++counter}`;
      const type = file.type || "application/octet-stream";
      const pending: PendingFile = { key, name: file.name || "shared file", type, size: file.size, preview: isImage(type) ? file.uri : null, state: "uploading" };
      setFiles((cur) => [...cur, pending]);
      if (file.size > MAX_BYTES) {
        patch(key, { state: "error", error: `larger than ${formatBytes(MAX_BYTES)}` });
        continue;
      }
      readBase64(file)
        .then((data) => api.uploadAttachment(sessionId, { name: pending.name, type, data }))
        .then((attachment) => patch(key, { state: "ready", attachment }), (e: Error) => patch(key, { state: "error", error: e.message }));
    }
  }, [sessionId, api]);

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
