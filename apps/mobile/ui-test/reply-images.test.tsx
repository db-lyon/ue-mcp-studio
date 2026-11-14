import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { Transport } from "@ue-mcp-studio/client-core";
import { ReplyMarkdown } from "../src/chat/ReplyMarkdown";
import { fakeApi, fakeProject, renderInProject, settle } from "./helpers";

/** A transport answering every picture with `bytes` as `type`, and the paths it was asked for. */
function serving(type: string, bytes = new Uint8Array([1, 2, 3])) {
  const asked: string[] = [];
  const transport: Transport = async (_method, path) => {
    asked.push(path);
    return { status: 200, headers: { "content-type": type }, body: (async function* () { yield bytes; })() };
  };
  return { asked, project: fakeProject(transport).project };
}

const pictures = () => [...document.querySelectorAll<HTMLImageElement>("img[data-expo-image]")];

describe("images in a reply on the phone", () => {
  it("loads a project image through Studio and draws it with expo-image", async () => {
    const { asked, project } = serving("image/jpeg");
    renderInProject(<ReplyMarkdown text={"![Step 2: enemy meets the player](Saved/MCPObservations/run/captures/step02.jpg)"} />, fakeApi(), project);
    await settle();
    expect(asked).toEqual(["/v1/ext/studio/files/image?path=Saved%2FMCPObservations%2Frun%2Fcaptures%2Fstep02.jpg"]);
    const [img] = pictures();
    expect(img.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,AQID/);
    expect(img.closest("[aria-label]")?.getAttribute("aria-label")).toBe("Step 2: enemy meets the player");
  });

  // React Native's Image drew a reply's GIF from a data URI nested in a Text: on Android an inline
  // attachment, and an animated WebP its first frame only. expo-image plays both, on Android and iOS.
  it("plays a GIF capture inline, on a line of its own between the text around it", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
    const { project } = serving("image/gif", gif);
    renderInProject(<ReplyMarkdown text={"Here is the charge attack in PIE:\n![Charge attack sequence](Saved/Captures/ChargeAttack_Sequence.gif)\nThe dash now ends in the knockdown."} />, fakeApi(), project);
    await settle();
    const [img] = pictures();
    expect(img.getAttribute("src")).toMatch(/^data:image\/gif;base64,R0lGODlh/);
    expect(img.dataset.autoplay).toBe("true");
    expect(img.dataset.contentFit).toBe("contain");
    // Not inside a Text (react-native-web marks a Text's element dir="auto"), and the text on either side kept.
    expect(screen.getByText("Here is the charge attack in PIE:").closest("[dir='auto']")).not.toBeNull();
    expect(img.closest("[dir='auto']")).toBeNull();
    expect(screen.getByText("The dash now ends in the knockdown.")).toBeTruthy();
  });

  it("shows every format the computer shows inline: GIF, WebP, PNG and JPEG", async () => {
    for (const [ext, type] of [["gif", "image/gif"], ["webp", "image/webp"], ["png", "image/png"], ["jpg", "image/jpeg"]]) {
      const { project } = serving(type);
      const view = renderInProject(<ReplyMarkdown text={`![shot ${ext}](Saved/Screenshots/shot.${ext})`} />, fakeApi(), project);
      await settle();
      const [img] = pictures();
      expect(img?.getAttribute("src"), ext).toMatch(new RegExp(`^data:${type.replace("/", "\\/")};base64,`));
      expect(img.dataset.autoplay, ext).toBe("true");
      view.unmount();
    }
  });

  it("opens the picture full screen on a tap, playing, and closes it", async () => {
    const { project } = serving("image/gif");
    renderInProject(<ReplyMarkdown text={"![Lock-on shoulder swap](Saved/Captures/LockOn_ShoulderSwap.gif)"} />, fakeApi(), project);
    await settle();
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
    renderInProject(<><ReplyMarkdown text={"![a](Saved/Captures/same.gif)"} /><ReplyMarkdown text={"![b](Saved/Captures/same.gif)"} /></>, fakeApi(), project);
    await settle();
    await settle();
    expect(asked).toHaveLength(1);
    expect(pictures()).toHaveLength(2);
  });

  it("keeps the alt text when the computer cannot read the picture", async () => {
    const transport: Transport = async () => ({ status: 404, headers: { "content-type": "application/json" }, body: (async function* () { yield new TextEncoder().encode("{}"); })() });
    renderInProject(<ReplyMarkdown text={"![Lost capture](Saved/Captures/lost.gif)"} />, fakeApi(), fakeProject(transport).project);
    await settle();
    expect(pictures()).toHaveLength(0);
    expect(screen.getByText("Lost capture")).toBeTruthy();
  });
});
