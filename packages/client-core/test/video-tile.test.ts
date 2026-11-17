import { describe, expect, it } from "vitest";
import { ATTACHMENT_PART_BYTES, type AttachmentUpload } from "@ue-mcp-studio/shared";
import { addingLabel, failedFilesNote, uploadChunked, uploadInParts, videoTile } from "../src/index.js";

const MB = 1024 * 1024;
const clip = (size: number) => ({ id: "a", name: "clip.mp4", type: "video/mp4", size });

describe("videoTile", () => {
  it("plays any size on the computer, and within the plan's relay limit on a paired device", () => {
    const remotePlan = { relay: 10 * MB, compress: true };
    expect(videoTile(clip(500 * MB), remotePlan, null, false).play?.id).toBe("a");
    expect(videoTile(clip(9 * MB), remotePlan, null, true).play?.id).toBe("a");
    const big = videoTile(clip(30 * MB), remotePlan, null, true);
    expect(big).toMatchObject({ play: null, compress: true, recheck: false, openOnComputer: true });
    expect(videoTile(clip(30 * MB), remotePlan, { ...clip(900), id: "b" }, true).play?.id).toBe("b");
  });

  it("offers Check again without an encoder, and Open on the computer always", () => {
    expect(videoTile(clip(80 * MB), { relay: 50 * MB, compress: false }, null, true)).toMatchObject({ play: null, compress: false, recheck: true, openOnComputer: true });
  });
});

describe("uploadChunked", () => {
  it("reads and sends a file a part at a time, never whole, in order and decodable alone", async () => {
    const bytes = Buffer.alloc(ATTACHMENT_PART_BYTES * 3 + 7, 5);
    const reads: Array<[number, number]> = [];
    const sent: AttachmentUpload[] = [];
    const seen: number[] = [];
    const r = await uploadChunked(
      async (u) => (sent.push(u), u.part && !u.part.last ? { received: true } : clip(1)),
      { name: "big.bin", type: "application/octet-stream", size: bytes.length },
      async (offset, length) => (reads.push([offset, length]), bytes.subarray(offset, offset + length).toString("base64")),
      (n) => seen.push(n),
    );
    expect(r).toEqual(clip(1));
    expect(Math.max(...reads.map(([, l]) => l))).toBeLessThanOrEqual(ATTACHMENT_PART_BYTES);
    expect(sent.map((u) => [u.part?.index, u.part?.last])).toEqual([[0, false], [1, false], [2, false], [3, true]]);
    expect(Buffer.concat(sent.map((u) => Buffer.from(u.data, "base64"))).equals(bytes)).toBe(true);
    expect(seen.at(-1)).toBe(bytes.length);
  });

  it("sends a file that fits one request whole", async () => {
    const sent: AttachmentUpload[] = [];
    await uploadChunked(async (u) => (sent.push(u), clip(1)), { name: "s.bin", type: "x/y", size: 3 }, async () => "QUJD");
    expect(sent).toHaveLength(1);
    expect(sent[0].part).toBeUndefined();
  });

  it("describes a failed upload's way on", () => {
    expect(failedFilesNote(1)).toMatch(/Retry it, or send without it/);
    expect(failedFilesNote(3)).toMatch(/3 files did not upload/);
    expect(addingLabel(1000, 250)).toBe("adding 25%");
    expect(addingLabel(1000)).toBe("adding");
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
