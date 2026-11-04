/**
 * A picture the daemon serves (a review thumbnail or capture), read through
 * the project's transport: a relayed phone has no URL an Image could load, so
 * the bytes come over the sealed channel and the Image gets a data URI.
 */
import { useEffect, useState } from "react";
import { useProjectNav } from "../../../nav";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)] + (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") + (i + 2 < bytes.length ? B64[c & 63] : "=");
  }
  return out;
}

/** The picture at `path` as a data URI; null while it loads, "failed" when it could not be read. */
export function useDaemonImage(path: string | null): string | null | "failed" {
  const { api } = useProjectNav();
  const [uri, setUri] = useState<string | null | "failed">(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setUri(null);
    api.bytes(path).then(
      (r) => live && setUri(`data:${r.type.split(";")[0]};base64,${base64(r.data)}`),
      () => live && setUri("failed"),
    );
    return () => {
      live = false;
    };
  }, [api, path]);
  return path ? uri : null;
}
