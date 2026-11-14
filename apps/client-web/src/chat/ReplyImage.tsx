import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  IMAGE_LOAD_FAILED,
  IMAGE_RETRY,
  IMAGE_TILE_MAX_HEIGHT,
  IMAGE_TILE_MAX_WIDTH,
  LEGACY_IMAGE_ASPECT,
  ReplyImageLoads,
  asksPoster,
  imageKind,
  imageProgress,
  imageProgressLabel,
  imageTileCaption,
  type ReplyImageFetchers,
} from "@ue-mcp-studio/client-core";
import { projectImagePosterUrl, projectImageUrl, type ReplyImageInfo } from "@ue-mcp-studio/shared";

/** What the daemon sent of the reply's images, by path; absent for a reply from an older Studio, and in the file viewer. */
export const ReplyImagesContext = createContext<Record<string, ReplyImageInfo> | undefined>(undefined);

/** Every reply picture's load for the page's life: a picture shown in two rows, or again after a scroll, is read once. */
export const replyImageLoads = new ReplyImageLoads();

/**
 * Reads a picture into a blob URL, reporting bytes as they arrive. The same
 * fetch reaches the daemon on the computer and, in a paired browser, the
 * relay's service worker, which answers it as it answers an image tag.
 */
async function readPicture(url: string, progress?: (received: number, total: number | null) => void): Promise<string> {
  const res = await fetch(url, { credentials: "same-origin", headers: { accept: "image/*" } });
  if (!res.ok) throw new Error(`${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const length = Number(res.headers.get("content-length")) || null;
  if (!res.body) return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    progress?.(received, length);
  }
  return URL.createObjectURL(new Blob(parts as BlobPart[], { type }));
}

/**
 * A project image in a reply, as a tile at its final size from the start: the
 * poster while the file loads, with how far it has come, then the file in its
 * place, playing when it is animated. A failed read keeps the tile, with the
 * caption and Retry. A click on a loaded one opens it full size.
 */
export function ReplyImage({ path, alt }: { path: string; alt: string }) {
  const info = useContext(ReplyImagesContext)?.[path];
  const url = projectImageUrl(path);
  const fetchers = useMemo<ReplyImageFetchers>(() => ({
    poster: asksPoster(info) ? () => readPicture(projectImagePosterUrl(path)) : null,
    full: (progress) => readPicture(url, progress),
  }), [path, url, info?.poster]);
  const total = info?.bytes ?? null;
  const state = useSyncExternalStore((fn) => replyImageLoads.subscribe(url, fn), () => replyImageLoads.get(url));
  useEffect(() => replyImageLoads.load(url, fetchers, total), [url, fetchers, total]);
  // The poster stays under the file until the file has drawn, so the tile never blinks empty.
  const [drawn, setDrawn] = useState<string | null>(null);
  const shown = state.full !== null && drawn === state.full;

  const width = info ? Math.min(info.width, IMAGE_TILE_MAX_WIDTH, (IMAGE_TILE_MAX_HEIGHT * info.width) / info.height) : IMAGE_TILE_MAX_WIDTH;
  const box = { width: `${Math.max(1, Math.round(width))}px`, aspectRatio: info ? `${info.width} / ${info.height}` : `${LEGACY_IMAGE_ASPECT}` };
  const phase = state.failed ? "failed" : shown ? "loaded" : state.poster ? "poster" : "waiting";
  const fraction = imageProgress(state.received, state.total ?? total);
  const progress = imageProgressLabel(state.received, state.total ?? total);

  const tile = (
    <span className={`md-image-tile is-${phase}${info ? "" : " is-legacy"}`} style={box} data-phase={phase} role={phase === "loaded" ? undefined : "img"} aria-label={phase === "loaded" ? undefined : alt} aria-busy={phase === "poster" || phase === "waiting" ? true : undefined}>
      {state.poster && !shown ? <img className="md-image-poster" src={state.poster} alt="" aria-hidden /> : null}
      {!state.poster && !shown && !state.failed ? <span className="md-image-kind" aria-hidden>{imageKind(info?.type ?? (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? ""))}</span> : null}
      {state.full ? <img className="md-image" src={state.full} alt={alt} onLoad={() => setDrawn(state.full)} /> : null}
      {!shown && !state.failed ? (
        <span className="md-image-status" role="status">
          <span className="spinner small" aria-hidden />
          <span>{progress ?? imageTileCaption(info, path)}</span>
        </span>
      ) : null}
      {!shown && !state.failed && fraction !== null && fraction > 0 ? (
        <span className="md-image-bar" aria-hidden><span style={{ width: `${Math.round(fraction * 100)}%` }} /></span>
      ) : null}
      {state.failed ? (
        <span className="md-image-failed">
          {alt ? <span className="md-image-caption">{alt}</span> : null}
          <span className="dim">{IMAGE_LOAD_FAILED}</span>
          <button type="button" className="small-button" onClick={() => replyImageLoads.retry(url, fetchers, total)}>{IMAGE_RETRY}</button>
        </span>
      ) : null}
    </span>
  );
  // Full size on a click, from the computer's own route, once there is a picture to open.
  return state.failed ? tile : <a className="md-image-link" href={url} target="_blank" rel="noreferrer" title={path}>{tile}</a>;
}
