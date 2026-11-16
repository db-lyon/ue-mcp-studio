/**
 * Studio's own ffmpeg: fetched on first use, checked against its pin, and a
 * real encode. The encode runs with STUDIO_FFMPEG_E2E=1, which fetches the
 * pinned build for real (about 30 MB) unless one is already on the computer.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { FFMPEG_PINS, compressVideo, durationOf, ensureFfmpeg, forgetFfmpeg, ownFfmpeg } from "../src/video.js";

let tools: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tools = fs.mkdtempSync(path.join(os.tmpdir(), "studio-tools-"));
  // No PATH: nothing found, so the fetch is what is tested.
  env = { STUDIO_TOOLS_DIR: tools, PATH: "" };
  forgetFfmpeg();
});
afterEach(() => forgetFfmpeg());

const body = (bytes: Buffer) => new Response(zlib.gzipSync(bytes));

describe("ensureFfmpeg", () => {
  it("fetches the pinned build, checks its SHA-256, and keeps it in the tools folder", async () => {
    const exe = Buffer.from("not really ffmpeg");
    const pin = { asset: "ffmpeg-test.gz", sha256: crypto.createHash("sha256").update(exe).digest("hex"), bytes: exe.length };
    const urls: string[] = [];
    const got = await ensureFfmpeg({ env, pin, fetch: (async (u: string) => (urls.push(u), body(exe))) as typeof fetch });
    expect(got).toBe(ownFfmpeg(env));
    expect(fs.readFileSync(got).equals(exe)).toBe(true);
    expect(urls[0]).toMatch(/^https:\/\/github\.com\/eugeneware\/ffmpeg-static\/releases\/download\/b6\.1\.1\/ffmpeg-test\.gz$/);
  });

  it("keeps nothing when the download does not match its pin, and says how to go on", async () => {
    const pin = { asset: "ffmpeg-test.gz", sha256: "0".repeat(64), bytes: 1 };
    await expect(ensureFfmpeg({ env, pin, fetch: (async () => body(Buffer.from("tampered"))) as typeof fetch })).rejects.toThrow(/checksum.*Press Compress to try again/);
    expect(fs.existsSync(ownFfmpeg(env))).toBe(false);
    expect(fs.readdirSync(path.dirname(ownFfmpeg(env)))).toEqual([]);
  });

  it("pins a build with a checksum for Windows, both Macs and Linux", () => {
    for (const k of ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"]) expect(FFMPEG_PINS[k].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.runIf(process.env.STUDIO_FFMPEG_E2E === "1")("a real encode", () => {
  it("fetches ffmpeg when needed, and compresses a 1080p clip to fit the relay limit", async () => {
    const ffmpeg = await ensureFfmpeg({ env: { ...process.env, STUDIO_TOOLS_DIR: process.env.STUDIO_TOOLS_DIR ?? path.join(os.homedir(), ".ue-mcp-studio", "tools") } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "studio-encode-"));
    const src = path.join(dir, "big.mp4");
    // Twenty seconds of noisy 1080p at a high rate: well over 10 MB.
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30,noise=alls=40:allf=t", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "20", "-c:v", "libx264", "-b:v", "8M", "-c:a", "aac", "-shortest", src], { windowsHide: true });
    expect(fs.statSync(src).size).toBeGreaterThan(10 * 1024 * 1024);
    const out = path.join(dir, "small.mp4");
    const r = await compressVideo(src, out, 10 * 1024 * 1024, ffmpeg);
    expect(r).toMatchObject({ ok: true });
    expect(fs.statSync(out).size).toBeLessThanOrEqual(10 * 1024 * 1024);
    let report = "";
    try {
      execFileSync(ffmpeg, ["-hide_banner", "-i", out], { windowsHide: true, stdio: "pipe" });
    } catch (e) {
      report = String((e as { stderr?: Buffer }).stderr ?? "");
    }
    expect(durationOf(report)).toBeGreaterThan(19);
    expect(report).toMatch(/Video: h264/);
  }, 600_000);
});
