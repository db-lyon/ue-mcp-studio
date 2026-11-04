/**
 * chat/attachments.ts: the open session, for anything that links to its files,
 * and a session file as a picture the app can draw. The composer's
 * useAttachments joins this file with the composer's port.
 */
import { createContext, useEffect, useState } from "react";
import { readAll } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";

export { attachmentUrl, formatBytes, isImage, MAX_BYTES } from "@ue-mcp-studio/client-core";

/** The open session, for anything that links to its files. */
export const SessionIdContext = createContext<string | null>(null);

const cache = new Map<string, string>();

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * A file the daemon serves, as a data URI: the app reaches the daemon through
 * the relay, sealed, so an image cannot be fetched by its URL. Null until it
 * has loaded, or when it cannot be read.
 */
export function useDaemonImage(path: string | undefined, type = "image/png"): string | null {
  const { project } = useProjectNav();
  const [uri, setUri] = useState<string | null>(() => (path ? cache.get(path) ?? null : null));
  useEffect(() => {
    if (!path) return setUri(null);
    const hit = cache.get(path);
    if (hit) return setUri(hit);
    let alive = true;
    project
      .transport("GET", path)
      .then(async (r) => {
        if (r.status >= 400) return;
        const data = `data:${r.headers["content-type"] ?? type};base64,${base64(await readAll(r))}`;
        cache.set(path, data);
        if (alive) setUri(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, project, type]);
  return uri;
}
