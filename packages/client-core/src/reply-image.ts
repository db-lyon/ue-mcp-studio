/**
 * A project image in a reply, drawn as a tile at its final size from the
 * start: the size and type the daemon sent with the reply (ReplyImageInfo)
 * give the tile its box, its poster (the first frame, a few KB) fills it
 * within a second, and the whole file replaces the poster in place once it
 * has arrived, playing when it is animated. A failed read leaves the tile with
 * its caption and Retry. A reply from an older Studio, without the facts, gets
 * a 16:9 tile the picture is fitted into.
 *
 * Both clients draw it; this is what they share: the box, the words, and the
 * loads, one per picture however many rows show it, the poster before the file.
 */
import type { ReplyImageInfo } from "@ue-mcp-studio/shared";
import { formatBytes } from "./composer.js";

/** `.md-image`: at most 640 wide and 480 tall, within the message. */
export const IMAGE_TILE_MAX_WIDTH = 640;
export const IMAGE_TILE_MAX_HEIGHT = 480;
/** The shape of a tile whose picture's size is not known. */
export const LEGACY_IMAGE_ASPECT = 16 / 9;

/**
 * The tile's box in a line `room` wide: the picture's own size shrunk to fit
 * 640 by 480 and the line, never stretched; 16:9 across the line when its size
 * is not known.
 */
export function imageTileSize(info: Pick<ReplyImageInfo, "width" | "height"> | undefined, room: number): { width: number; height: number } {
  const across = Math.max(1, Math.min(room, IMAGE_TILE_MAX_WIDTH));
  if (!info || info.width < 1 || info.height < 1) {
    const height = Math.min(IMAGE_TILE_MAX_HEIGHT, across / LEGACY_IMAGE_ASPECT);
    return { width: Math.round(height * LEGACY_IMAGE_ASPECT), height: Math.round(height) };
  }
  const k = Math.min(1, across / info.width, IMAGE_TILE_MAX_HEIGHT / info.height);
  return { width: Math.max(1, Math.round(info.width * k)), height: Math.max(1, Math.round(info.height * k)) };
}

/** GIF, PNG, JPEG, WEBP, BMP. */
export const imageKind = (type: string): string => {
  const sub = type.split(";")[0].trim().toLowerCase().replace(/^image\//, "");
  return sub === "jpeg" ? "JPEG" : sub.toUpperCase() || "IMAGE";
};

/** What the tile says of the picture while it loads: "Animated GIF, 11.8 MB". */
export function imageTileCaption(info: ReplyImageInfo | undefined, path?: string): string {
  if (!info) {
    const ext = path ? /\.([a-z0-9]+)$/i.exec(path)?.[1] : undefined;
    return ext ? `${imageKind(ext === "jpg" ? "jpeg" : ext)} image` : "Image";
  }
  return `${info.animated ? "Animated " : ""}${imageKind(info.type)}, ${formatBytes(info.bytes)}`;
}

/** How far the file has come: 0 to 1 when its size is known, null otherwise. */
export const imageProgress = (received: number, total: number | null): number | null =>
  total && total > 0 ? Math.max(0, Math.min(1, received / total)) : null;

/** "3.1 of 11.8 MB", or "3.1 MB" when the size is not known; null before the first byte. */
export function imageProgressLabel(received: number, total: number | null): string | null {
  if (received <= 0) return null;
  if (!total) return formatBytes(received);
  const mb = total >= 1024 * 1024;
  const part = mb ? (received / 1024 / 1024).toFixed(1) : String(Math.max(1, Math.round(received / 1024)));
  return `${part} of ${formatBytes(total)}`;
}

export const IMAGE_LOADING = "Loading";
export const IMAGE_LOAD_FAILED = "The picture did not load.";
export const IMAGE_RETRY = "Retry";

/** One picture's load: its poster and file as URIs the client draws, and how far the file has come. */
export interface ReplyImageState {
  poster: string | null;
  full: string | null;
  received: number;
  total: number | null;
  failed: boolean;
}

/** How a client reads a picture: the poster (null when it has none), and the file, reporting bytes as they arrive. */
export interface ReplyImageFetchers {
  poster: (() => Promise<string>) | null;
  full: (progress: (received: number, total: number | null) => void) => Promise<string>;
}

const EMPTY: ReplyImageState = { poster: null, full: null, received: 0, total: null, failed: false };

/** Whether to ask for a poster: when the reply says there is one, or does not say. */
export const asksPoster = (info: ReplyImageInfo | undefined): boolean => !info || info.poster === true;

/**
 * Every picture's load for the run, by a key the client chooses (its URL, and
 * on the phone its computer). The poster is read first, and the file once the
 * poster has come or `posterWait` has passed, so over the relay the poster is
 * not queued behind 12 MB. A load that failed is tried again by retry().
 */
export class ReplyImageLoads {
  private readonly states = new Map<string, ReplyImageState>();
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly running = new Set<string>();

  constructor(private readonly posterWait = 1500) {}

  get(key: string): ReplyImageState {
    return this.states.get(key) ?? EMPTY;
  }

  subscribe(key: string, fn: () => void): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (!set!.size) this.listeners.delete(key);
    };
  }

  private set(key: string, change: Partial<ReplyImageState>): void {
    this.states.set(key, { ...this.get(key), ...change });
    for (const fn of [...(this.listeners.get(key) ?? [])]) fn();
  }

  /** Starts the picture's load unless it is loading, loaded, or failed (retry() for that). */
  load(key: string, fetchers: ReplyImageFetchers, total: number | null = null): void {
    const s = this.get(key);
    if (this.running.has(key) || s.full || s.failed) return;
    void this.run(key, fetchers, total);
  }

  /** Loads a picture that failed again. */
  retry(key: string, fetchers: ReplyImageFetchers, total: number | null = null): void {
    if (this.running.has(key) || this.get(key).full) return;
    this.set(key, { failed: false, received: 0 });
    void this.run(key, fetchers, total);
  }

  private async run(key: string, fetchers: ReplyImageFetchers, total: number | null): Promise<void> {
    this.running.add(key);
    this.set(key, { failed: false, received: 0, total });
    try {
      if (fetchers.poster && !this.get(key).poster) {
        const poster = fetchers.poster().then((uri) => this.set(key, { poster: uri }), () => undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([poster, new Promise<void>((r) => (timer = setTimeout(r, this.posterWait)))]);
        clearTimeout(timer);
      }
      // One update per percent (or per 256 KB when the size is not known), not one per chunk.
      let shown = -1;
      const uri = await fetchers.full((received, size) => {
        const of = size ?? total;
        const step = of ? Math.floor((received / of) * 100) : Math.floor(received / 262144);
        if (step === shown) return;
        shown = step;
        this.set(key, { received, total: of });
      });
      this.set(key, { full: uri, failed: false });
    } catch {
      this.set(key, { failed: true });
    } finally {
      this.running.delete(key);
    }
  }
}
