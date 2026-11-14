import { beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import type { ReplyImageInfo } from "@ue-mcp-studio/shared";
import { ReplyImagesContext, ReplyMarkdown } from "../src/chat/ReplyMarkdown";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

type Answer = { status: number; type: string; chunks: AsyncIterable<Uint8Array> };
const once = (bytes: Uint8Array, type: string, status = 200): Answer => ({ status, type, chunks: (async function* () { yield bytes; })() });

/** A stream the test feeds by hand, as the relay delivers a large file. */
function fed() {
  const queue: Array<Uint8Array | null> = [];
  let wake: (() => void) | null = null;
  const chunks = (async function* () {
    for (;;) {
      while (!queue.length) await new Promise<void>((r) => (wake = r));
      const next = queue.shift()!;
      if (next === null) return;
      yield next;
    }
  })();
  const put = (c: Uint8Array | null) => {
    queue.push(c);
    wake?.();
    wake = null;
  };
  return { chunks, push: (n: number) => put(new Uint8Array(n)), end: () => put(null) };
}

/**
 * A transport answering pictures: `answer` picks by path, anything else gets
 * three bytes of `type`. The paths it was asked for, in order.
 */
function serving(type: string, answer: (path: string) => Answer | Promise<Answer> | undefined = () => undefined) {
  const asked: string[] = [];
  const transport: Transport = async (_method, path) => {
    asked.push(path);
    const a = (await answer(path)) ?? once(new Uint8Array([1, 2, 3]), type);
    return { status: a.status, headers: { "content-type": a.type }, body: a.chunks };
  };
  return { asked, project: fakeProject(transport).project };
}

const never = (): Promise<Answer> => new Promise(() => {});
const pictures = () => [...document.querySelectorAll<HTMLImageElement>("img[data-expo-image]")].filter((i) => i.dataset.testid === "picture" || !i.dataset.testid);
const tile = () => document.querySelector<HTMLElement>("[data-testid='reply-image-tile']")!;
const poster = () => document.querySelector<HTMLImageElement>("img[data-testid='reply-image-poster']");
const GIF: ReplyImageInfo = { type: "image/gif", width: 720, height: 366, bytes: 1000, frames: 96, animated: true, poster: true };
const reply = (text: string, images?: Record<string, ReplyImageInfo>) => <ReplyImagesContext.Provider value={images}><ReplyMarkdown text={text} /></ReplyImagesContext.Provider>;

describe("images in a reply on the phone", () => {
  // jsdom lays nothing out: a phone's 414 dp window, so the tile has a line to fit.
  beforeAll(() => {
    Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 414 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 860 });
    window.dispatchEvent(new Event("resize"));
  });

  it("draws the tile at the picture's own size before a byte has arrived, never as a link of its caption", async () => {
    const path = "Saved/Captures/Waiting.gif";
    const { asked, project } = serving("image/gif", () => never());
    renderInProject(reply(`![Charge attack](${path})`, { [path]: GIF }), fakeApi(), project);
    await settle();
    expect(tile().dataset.phase).toBe("waiting");
    // The line is the window less the reply's sides; the tile keeps the picture's 720:366.
    const w = parseFloat(tile().style.width) - 2;
    const h = parseFloat(tile().style.height) - 2;
    expect(w / h).toBeCloseTo(720 / 366, 1);
    expect(tile().getAttribute("aria-label")).toBe("Charge attack");
    expect(screen.getByText("Animated GIF, 1 KB")).toBeTruthy();
    expect(screen.getByText("GIF")).toBeTruthy();
    expect(screen.queryByText("Charge attack")).toBeNull();
    expect(asked).toEqual([`/v1/ext/studio/files/image?path=${encodeURIComponent(path)}&poster=1`]);
  });

  it("shows the poster first, then how far the file has come, then the file in its place, playing", async () => {
    const path = "Saved/Captures/ChargeAttack_Sequence.gif";
    const file = fed();
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const { asked, project } = serving("image/gif", (p) => (p.endsWith("&poster=1") ? once(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg") : { status: 200, type: "image/gif", chunks: file.chunks }));
    renderInProject(reply(`Here is the charge attack in PIE:\n![Charge attack sequence](${path})\nThe dash now ends in the knockdown.`, { [path]: GIF }), fakeApi(), project);
    await settle();
    await settle();
    expect(tile().dataset.phase).toBe("poster");
    expect(poster()?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
    // The poster was asked for before the file.
    expect(asked).toEqual([`/v1/ext/studio/files/image?path=${encodeURIComponent(path)}&poster=1`, `/v1/ext/studio/files/image?path=${encodeURIComponent(path)}`]);
    await act(async () => file.push(400));
    await settle();
    expect(document.querySelector<HTMLElement>("[data-testid='reply-image-bar']")!.style.width).toBe("40%");
    await act(async () => {
      file.push(600);
      file.end();
    });
    await settle();
    const [img] = pictures();
    expect(img.getAttribute("src")).toMatch(/^data:image\/gif;base64,/);
    expect(img.dataset.autoplay).toBe("true");
    // The poster stays under the file until it has drawn.
    expect(poster()).not.toBeNull();
    fireEvent.load(img);
    await settle();
    expect(tile().dataset.phase).toBe("loaded");
    expect(poster()).toBeNull();
    expect(screen.queryByTestId("reply-image-status")).toBeNull();
    // Not inside a Text (react-native-web marks a Text's element dir="auto"), and the text on either side kept.
    expect(img.closest("[dir='auto']")).toBeNull();
    expect(screen.getByText("Here is the charge attack in PIE:")).toBeTruthy();
    expect(screen.getByText("The dash now ends in the knockdown.")).toBeTruthy();
  });

  it("asks for no poster when the reply says the picture is small enough to load whole", async () => {
    const path = "Saved/Screenshots/small.png";
    const { asked, project } = serving("image/png");
    renderInProject(reply(`![Small](${path})`, { [path]: { type: "image/png", width: 64, height: 32, bytes: 900, frames: 1, animated: false } }), fakeApi(), project);
    await settle();
    await settle();
    expect(asked).toEqual([`/v1/ext/studio/files/image?path=${encodeURIComponent(path)}`]);
    expect(tile().style.width).toBe("66px");
    expect(pictures()).toHaveLength(1);
  });

  it("shows every format the computer shows inline: GIF, WebP, PNG and JPEG", async () => {
    for (const [ext, type] of [["gif", "image/gif"], ["webp", "image/webp"], ["png", "image/png"], ["jpg", "image/jpeg"]]) {
      const { project } = serving(type, (p) => (p.endsWith("&poster=1") ? once(new Uint8Array(0), "application/json", 404) : undefined));
      const view = renderInProject(reply(`![shot ${ext}](Saved/Screenshots/format.${ext})`), fakeApi(), project);
      await settle();
      await settle();
      const [img] = pictures();
      expect(img?.getAttribute("src"), ext).toMatch(new RegExp(`^data:${type.replace("/", "\\/")};base64,`));
      expect(img.dataset.autoplay, ext).toBe("true");
      view.unmount();
    }
  });

  it("opens the picture full screen on a tap, playing, and closes it", async () => {
    const { project } = serving("image/gif");
    renderInProject(reply("![Lock-on shoulder swap](Saved/Captures/LockOn_ShoulderSwap.gif)"), fakeApi(), project);
    await settle();
    await settle();
    fireEvent.load(pictures()[0]);
    expect(screen.queryByTestId("picture-viewer")).toBeNull();
    fireEvent.click(screen.getByLabelText("Lock-on shoulder swap", { selector: "[tabindex]" }));
    const viewer = await screen.findByTestId("picture-viewer");
    const full = viewer.querySelector<HTMLImageElement>("img[data-expo-image]")!;
    expect(full.getAttribute("src")).toMatch(/^data:image\/gif;base64,/);
    expect(full.dataset.autoplay).toBe("true");
    fireEvent.click(screen.getByLabelText("Close"));
    await settle();
    expect(screen.queryByTestId("picture-viewer")).toBeNull();
  });

  it("reads a picture once however many replies show it", async () => {
    const { asked, project } = serving("image/gif");
    renderInProject(<>{reply("![a](Saved/Captures/same.gif)")}{reply("![b](Saved/Captures/same.gif)")}</>, fakeApi(), project);
    await settle();
    await settle();
    expect(asked.filter((p) => !p.endsWith("&poster=1"))).toHaveLength(1);
    expect(pictures()).toHaveLength(2);
  });

  it("keeps the tile when the read fails, with the caption and Retry, and loads again on Retry", async () => {
    const path = "Saved/Captures/lost.gif";
    let fail = true;
    const { project } = serving("image/gif", (p) => (fail || p.endsWith("&poster=1") ? once(new TextEncoder().encode("{}"), "application/json", 404) : undefined));
    renderInProject(reply(`![Lost capture](${path})`, { [path]: GIF }), fakeApi(), project);
    await settle();
    await settle();
    expect(tile().dataset.phase).toBe("failed");
    expect(pictures()).toHaveLength(0);
    expect(screen.getByText("Lost capture")).toBeTruthy();
    expect(screen.getByText("The picture did not load.")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByText("Retry"));
    await settle();
    await settle();
    fireEvent.load(pictures()[0]);
    await settle();
    expect(tile().dataset.phase).toBe("loaded");
  });

  it("gives a reply from an older Studio, without the picture's size, a 16:9 tile rather than a link", async () => {
    const path = "C:/Users/me/Vale/Saved/legacy04.jpg";
    const { asked, project } = serving("image/jpeg", () => never());
    renderInProject(reply(`![Step 4](${path})`), fakeApi(), project);
    await settle();
    expect(tile().dataset.legacy).toBe("true");
    const w = parseFloat(tile().style.width) - 2;
    const h = parseFloat(tile().style.height) - 2;
    expect(w / h).toBeCloseTo(16 / 9, 1);
    expect(screen.getByText("JPEG image")).toBeTruthy();
    expect(asked).toEqual(["/v1/ext/studio/files/image?path=C%3A%2FUsers%2Fme%2FVale%2FSaved%2Flegacy04.jpg&poster=1"]);
  });
});
