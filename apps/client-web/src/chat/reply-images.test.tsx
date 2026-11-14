// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReplyImageInfo } from "@ue-mcp-studio/shared";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { ReplyImagesContext } from "./ReplyImage";

/** A response the test feeds by hand: chunks pushed, then closed or failed. */
function controlled(status = 200, type = "image/gif") {
  let push!: (b: Uint8Array) => void;
  let close!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      push = (b) => c.enqueue(b);
      close = () => c.close();
    },
  });
  return { res: new Response(body, { status, headers: { "content-type": type } }), push: (n: number) => push(new Uint8Array(n)), close: () => close() };
}

let asked: string[];
let answers: Map<string, () => Response | Promise<Response>>;
let made = 0;

beforeEach(() => {
  asked = [];
  answers = new Map();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    asked.push(url);
    const a = [...answers.entries()].find(([k]) => url.includes(k));
    return a ? a[1]() : new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }));
  URL.createObjectURL = vi.fn(() => `blob:picture-${++made}`);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GIF: ReplyImageInfo = { type: "image/gif", width: 720, height: 366, bytes: 1000, frames: 96, animated: true, poster: true };
/** Each test its own path, since loads are kept for the page's life. */
let n = 0;
const fresh = (ext = "gif") => `Saved/Captures/run${++n}.${ext}`;
const reply = (path: string, alt: string, images?: Record<string, ReplyImageInfo>) =>
  render(<ReplyImagesContext.Provider value={images}><ReplyMarkdown text={`![${alt}](${path})`} /></ReplyImagesContext.Provider>);
const tile = () => document.querySelector(".md-image-tile") as HTMLElement;

describe("images in a reply", () => {
  it("draws the tile at the picture's own size before a byte has arrived, never as a link of its caption", async () => {
    const path = fresh();
    answers.set("poster=1", () => new Promise<Response>(() => {}));
    reply(path, "Charge attack", { [path]: GIF });
    expect(tile().style.width).toBe("640px");
    expect(tile().style.aspectRatio).toBe("720 / 366");
    expect(tile().dataset.phase).toBe("waiting");
    expect(tile().getAttribute("aria-label")).toBe("Charge attack");
    expect(screen.getByText("Animated GIF, 1 KB")).toBeTruthy();
    expect(screen.queryByText("Charge attack")).toBeNull();
    expect(asked[0]).toContain("poster=1");
  });

  it("shows the poster, then how far the file has come, then the file in its place", async () => {
    const path = fresh();
    const file = controlled();
    answers.set("poster=1", () => new Response(new Uint8Array([9]), { headers: { "content-type": "image/jpeg" } }));
    answers.set(`run${n}.gif`, () => file.res);
    reply(path, "Charge attack", { [path]: GIF });
    await waitFor(() => expect(tile().dataset.phase).toBe("poster"));
    expect((document.querySelector(".md-image-poster") as HTMLImageElement).getAttribute("src")).toMatch(/^blob:/);
    // The file is asked for only after the poster.
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[0]).toContain("poster=1");
    await act(async () => file.push(250));
    await waitFor(() => expect((document.querySelector(".md-image-bar > span") as HTMLElement).style.width).toBe("25%"));
    await act(async () => {
      file.push(750);
      file.close();
    });
    const img = await screen.findByAltText("Charge attack");
    expect(img.getAttribute("src")).toMatch(/^blob:/);
    // The poster stays under the file until it has drawn.
    expect(document.querySelector(".md-image-poster")).not.toBeNull();
    fireEvent.load(img);
    expect(tile().dataset.phase).toBe("loaded");
    expect(document.querySelector(".md-image-poster")).toBeNull();
    expect(document.querySelector(".md-image-status")).toBeNull();
    expect(img.closest("a")?.getAttribute("href")).toBe(`/v1/ext/studio/files/image?path=${encodeURIComponent(path)}`);
    expect(tile().style.width).toBe("640px");
  });

  it("asks for no poster when the reply says the picture is small enough to load whole", async () => {
    const path = fresh("png");
    reply(path, "Small", { [path]: { type: "image/png", width: 64, height: 32, bytes: 900, frames: 1, animated: false } });
    await screen.findByAltText("Small");
    expect(asked).toEqual([`/v1/ext/studio/files/image?path=${encodeURIComponent(path)}`]);
    expect(tile().style.width).toBe("64px");
  });

  it("keeps the tile when the read fails, with the caption and Retry, and loads again on Retry", async () => {
    const path = fresh();
    let fail = true;
    answers.set("poster=1", () => new Response(null, { status: 404 }));
    answers.set(`run${n}.gif`, () => (fail ? new Response(null, { status: 404 }) : new Response(new Uint8Array([1]), { headers: { "content-type": "image/gif" } })));
    reply(path, "Charge attack", { [path]: GIF });
    await waitFor(() => expect(tile().dataset.phase).toBe("failed"));
    expect(screen.getByText("Charge attack")).toBeTruthy();
    expect(screen.getByText("The picture did not load.")).toBeTruthy();
    expect(tile().closest("a")).toBeNull();
    expect(tile().style.aspectRatio).toBe("720 / 366");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.load(await screen.findByAltText("Charge attack"));
    expect(tile().dataset.phase).toBe("loaded");
  });

  it("gives a reply from an older Studio, without the picture's size, a 16:9 tile rather than a link", async () => {
    const path = "C:/Users/me/Vale/Saved/step04.jpg";
    answers.set("poster=1", () => new Promise<Response>(() => {}));
    reply(path, "Step 4");
    expect(tile().classList.contains("is-legacy")).toBe(true);
    expect(tile().style.aspectRatio).toBe(`${16 / 9}`);
    expect(screen.getByText("JPEG image")).toBeTruthy();
    expect(asked[0]).toBe("/v1/ext/studio/files/image?path=C%3A%2FUsers%2Fme%2FVale%2FSaved%2Fstep04.jpg&poster=1");
  });

  it("leaves a web image as it is", () => {
    render(<ReplyMarkdown text={"![logo](https://example.com/logo.png)"} />);
    expect((screen.getByAltText("logo") as HTMLImageElement).getAttribute("src")).toBe("https://example.com/logo.png");
  });
});
