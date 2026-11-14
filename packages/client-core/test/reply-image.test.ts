/** A reply's project image as both clients draw it: its box, its words, and its loads. */
import { describe, expect, it, vi } from "vitest";
import { ReplyImageLoads, imageProgress, imageProgressLabel, imageTileCaption, imageTileSize, type ReplyImageFetchers } from "../src/reply-image.js";

const GIF = { type: "image/gif", width: 720, height: 366, bytes: 12_373_000, frames: 96, animated: true, poster: true };

describe("the tile", () => {
  it("takes the picture's own size, shrunk to 640 by 480 and the line, never stretched", () => {
    expect(imageTileSize(GIF, 1000)).toEqual({ width: 640, height: 325 });
    expect(imageTileSize(GIF, 366)).toEqual({ width: 366, height: 186 });
    expect(imageTileSize({ width: 300, height: 900 }, 1000)).toEqual({ width: 160, height: 480 });
    expect(imageTileSize({ width: 120, height: 80 }, 1000)).toEqual({ width: 120, height: 80 });
  });

  it("is 16:9 across the line when the reply did not say the picture's size", () => {
    expect(imageTileSize(undefined, 1000)).toEqual({ width: 640, height: 360 });
    expect(imageTileSize(undefined, 366)).toEqual({ width: 366, height: 206 });
  });

  it("says what the picture is while it loads, and how far it has come", () => {
    expect(imageTileCaption(GIF)).toBe("Animated GIF, 11.8 MB");
    expect(imageTileCaption({ ...GIF, type: "image/jpeg", animated: false, bytes: 300_000 })).toBe("JPEG, 293 KB");
    expect(imageTileCaption(undefined, "Saved/shot.jpg")).toBe("JPEG image");
    expect(imageTileCaption(undefined)).toBe("Image");
    expect(imageProgress(3_000_000, 12_000_000)).toBe(0.25);
    expect(imageProgress(10, null)).toBeNull();
    expect(imageProgressLabel(0, 100)).toBeNull();
    expect(imageProgressLabel(3.25 * 1024 * 1024, GIF.bytes)).toBe("3.3 of 11.8 MB");
    expect(imageProgressLabel(2048, null)).toBe("2 KB");
  });
});

/** A fetch the test settles by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe("the loads", () => {
  it("reads the poster before the file, and the file once the poster has come", async () => {
    const loads = new ReplyImageLoads(60_000);
    const poster = deferred<string>();
    const full = deferred<string>();
    let progress: (r: number, t: number | null) => void = () => {};
    const f: ReplyImageFetchers = { poster: vi.fn(() => poster.promise), full: vi.fn((p) => ((progress = p), full.promise)) };
    const seen: string[] = [];
    loads.subscribe("a", () => seen.push(JSON.stringify(loads.get("a"))));
    loads.load("a", f, GIF.bytes);
    loads.load("a", f, GIF.bytes);
    await Promise.resolve();
    expect(f.poster).toHaveBeenCalledTimes(1);
    expect(f.full).not.toHaveBeenCalled();
    poster.resolve("poster:a");
    await vi.waitFor(() => expect(f.full).toHaveBeenCalledTimes(1));
    expect(loads.get("a").poster).toBe("poster:a");
    progress(GIF.bytes / 4, null);
    progress(GIF.bytes / 4 + 10, null);
    expect(loads.get("a")).toMatchObject({ received: GIF.bytes / 4, total: GIF.bytes, full: null });
    full.resolve("file:a");
    await vi.waitFor(() => expect(loads.get("a").full).toBe("file:a"));
    expect(loads.get("a")).toMatchObject({ poster: "poster:a", failed: false });
    // One update per percent: the second chunk inside the same percent sent none.
    expect(seen.filter((s) => s.includes(`"received":${GIF.bytes / 4 + 10}`))).toHaveLength(0);
  });

  it("starts the file anyway when the poster is slow, and goes straight to it when there is none", async () => {
    vi.useFakeTimers();
    try {
      const loads = new ReplyImageLoads(1500);
      const f: ReplyImageFetchers = { poster: () => new Promise<string>(() => {}), full: vi.fn(async () => "file:b") };
      loads.load("b", f);
      await vi.advanceTimersByTimeAsync(1499);
      expect(f.full).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(f.full).toHaveBeenCalledTimes(1);
      const g: ReplyImageFetchers = { poster: null, full: vi.fn(async () => "file:c") };
      loads.load("c", g);
      await vi.advanceTimersByTimeAsync(0);
      expect(loads.get("c").full).toBe("file:c");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a failed read, keeps it failed until Retry, and loads on Retry", async () => {
    const loads = new ReplyImageLoads(0);
    let fail = true;
    const f: ReplyImageFetchers = { poster: null, full: vi.fn(async () => (fail ? Promise.reject(new Error("404")) : "file:d")) };
    loads.load("d", f);
    await vi.waitFor(() => expect(loads.get("d").failed).toBe(true));
    loads.load("d", f);
    expect(f.full).toHaveBeenCalledTimes(1);
    fail = false;
    loads.retry("d", f);
    expect(loads.get("d").failed).toBe(false);
    await vi.waitFor(() => expect(loads.get("d").full).toBe("file:d"));
  });
});
