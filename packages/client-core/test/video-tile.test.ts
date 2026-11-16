import { describe, expect, it } from "vitest";
import { ATTACHMENT_PART_BYTES, VIDEO_PLAY_BYTES, VIDEO_PLAY_PAID_BYTES, type AttachmentUpload } from "@ue-mcp-studio/shared";
import { uploadInParts, videoTile } from "../src/index.js";

const clip = (size: number) => ({ id: "a", name: "clip.mp4", type: "video/mp4", size });

describe("videoTile", () => {
  it("plays within the limit, and plays the compressed copy once there is one", () => {
    const free = { limit: VIDEO_PLAY_BYTES, paid: false, compress: true };
    expect(videoTile(clip(1000), free, null).play?.id).toBe("a");
    const big = videoTile(clip(10 * 1048576), free, null);
    expect(big).toMatchObject({ play: null, compress: true, upgrade: true, recheck: false });
    expect(videoTile(clip(10 * 1048576), free, { ...clip(900), id: "b" }).play?.id).toBe("b");
  });

  it("offers Check again without an encoder, and no upgrade past the paid limit", () => {
    const paid = { limit: VIDEO_PLAY_PAID_BYTES, paid: true, compress: false };
    expect(videoTile(clip(30 * 1048576), paid, null)).toMatchObject({ play: null, compress: false, upgrade: false, recheck: true });
  });
});

describe("uploadInParts", () => {
  it("sends a small file whole and a large one in ordered parts that decode on their own", async () => {
    const sent: AttachmentUpload[] = [];
    const post = async (u: AttachmentUpload) => {
      sent.push(u);
      return u.part && !u.part.last ? { received: true } : clip(1);
    };
    await uploadInParts(post, { name: "s.mp4", type: "video/mp4", data: "QUJD" });
    expect(sent).toHaveLength(1);
    expect(sent[0].part).toBeUndefined();
    sent.length = 0;
    const bytes = Buffer.alloc(ATTACHMENT_PART_BYTES * 2 + 5, 9);
    const r = await uploadInParts(post, { name: "b.mp4", type: "video/mp4", data: bytes.toString("base64") });
    expect(r).toEqual(clip(1));
    expect(sent.map((u) => [u.part?.index, u.part?.last])).toEqual([[0, false], [1, false], [2, true]]);
    expect(Buffer.concat(sent.map((u) => Buffer.from(u.data, "base64"))).equals(bytes)).toBe(true);
  });
});
