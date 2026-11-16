/**
 * Smaller copies of videos a message carried, so one too large to play in the
 * chat still plays there. The encoder is ffmpeg: STUDIO_FFMPEG names one, else
 * the first on PATH or in WinGet's links folder, else Studio's own copy in its
 * tools folder. Without any, the first Compress fetches that copy: one pinned
 * ffmpeg build per platform, checked against its SHA-256 before it is kept,
 * so Compress and play works with nothing installed.
 */
import { execFile } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * The ffmpeg Studio fetches: release b6.1.1 of eugeneware/ffmpeg-static, a
 * static build with libx264, one gzipped executable per platform. `sha256` is
 * the executable's own, checked after it is unpacked.
 */
export const FFMPEG_BUILD = "b6.1.1";
export const FFMPEG_PINS: Readonly<Record<string, { asset: string; sha256: string; bytes: number }>> = {
  "win32-x64": { asset: "ffmpeg-win32-x64.gz", sha256: "04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00", bytes: 82_797_568 },
  "darwin-arm64": { asset: "ffmpeg-darwin-arm64.gz", sha256: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584", bytes: 45_568_216 },
  "darwin-x64": { asset: "ffmpeg-darwin-x64.gz", sha256: "ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894", bytes: 78_862_176 },
  "linux-x64": { asset: "ffmpeg-linux-x64.gz", sha256: "e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99", bytes: 79_826_272 },
};
const pinUrl = (asset: string): string => `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_BUILD}/${asset}`;

/** The pin for this computer, or null where no build is pinned. */
export const ffmpegPin = (platform: string = process.platform, arch: string = process.arch) => FFMPEG_PINS[`${platform}-${arch}`] ?? null;

/** Studio's tools folder, beside its keys: one copy for every project on the computer. */
export function toolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.STUDIO_TOOLS_DIR || path.join(os.homedir(), ".ue-mcp-studio", "tools");
}

/** Where Studio keeps its own ffmpeg. */
export const ownFfmpeg = (env: NodeJS.ProcessEnv = process.env): string => path.join(toolsDir(env), `ffmpeg-${FFMPEG_BUILD}`, EXE);

/** Where ffmpeg is, or null. Read once per process, then kept. */
let found: string | null | undefined;
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  if (found !== undefined) return found;
  const dirs = [
    ...(env.PATH ?? env.Path ?? "").split(path.delimiter),
    ...(process.platform === "win32" && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links")] : []),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
  ].filter(Boolean);
  const named = env.STUDIO_FFMPEG && fs.existsSync(env.STUDIO_FFMPEG) ? env.STUDIO_FFMPEG : null;
  const own = ownFfmpeg(env);
  found = named ?? dirs.map((d) => path.join(d, EXE)).find((p) => fs.existsSync(p)) ?? (fs.existsSync(own) ? own : null);
  return found;
}

/** Forget what findFfmpeg found, for a user who installs ffmpeg while Studio runs, and for tests. */
export function forgetFfmpeg(): void {
  found = undefined;
}

/** Whether Compress can work here: an ffmpeg is found, or a pinned one can be fetched. */
export const canCompress = (env: NodeJS.ProcessEnv = process.env): boolean => findFfmpeg(env) !== null || ffmpegPin() !== null;

let fetching: Promise<string> | null = null;

/**
 * An ffmpeg to run: the one found, else Studio's own, fetched now. The
 * download is unpacked to a temporary file, its SHA-256 checked against the
 * pin, and only then moved into place; a mismatch keeps nothing.
 */
export function ensureFfmpeg(o: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; pin?: ReturnType<typeof ffmpegPin> } = {}): Promise<string> {
  const env = o.env ?? process.env;
  const have = findFfmpeg(env);
  if (have) return Promise.resolve(have);
  const pin = o.pin === undefined ? ffmpegPin() : o.pin;
  if (!pin) return Promise.reject(new Error(`No ffmpeg build is pinned for ${process.platform}-${process.arch}; install ffmpeg on this computer, then try again.`));
  fetching ??= (async () => {
    const dest = ownFfmpeg(env);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.download`;
    try {
      const res = await (o.fetch ?? fetch)(pinUrl(pin.asset), { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`the download answered HTTP ${res.status}`);
      const hash = crypto.createHash("sha256");
      const gunzip = zlib.createGunzip();
      gunzip.on("data", (chunk: Buffer) => hash.update(chunk));
      await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), gunzip, fs.createWriteStream(tmp));
      const sum = hash.digest("hex");
      if (sum !== pin.sha256) throw new Error(`the download did not match its checksum (got ${sum.slice(0, 12)}...)`);
      if (process.platform !== "win32") fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, dest);
      forgetFfmpeg();
      return dest;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Studio could not fetch its video encoder: ${e instanceof Error ? e.message : String(e)}. Press Compress to try again, or install ffmpeg on this computer.`);
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stderr: String(stderr ?? "") });
    });
  });
}

/** A video's length in seconds from ffmpeg's report on it, or null. */
export function durationOf(report: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(report);
  if (!m) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return s > 0 ? s : null;
}

/**
 * The video bit rate (bits a second) that lands a `seconds`-long copy within
 * `bytes`, with 64 kbps of audio and a margin for the container. At least
 * 80 kbps, which plays small but plays.
 */
export function videoBitrate(bytes: number, seconds: number): number {
  return Math.max(80_000, Math.floor((bytes * 8 * 0.9) / seconds) - 64_000);
}

/** The width a copy at `bps` is scaled down to, so the picture is not mush. */
export const widthFor = (bps: number): number => (bps >= 1_500_000 ? 1280 : bps >= 600_000 ? 960 : bps >= 250_000 ? 640 : 426);

export type CompressResult = { ok: true; bytes: number } | { ok: false; error: string };

/**
 * Encode `src` into an H.264 MP4 at `dest` that fits within `bytes`: scaled
 * down and at a bit rate from the video's length, played from its start as it
 * loads. Up to ten minutes; a copy that still comes out too large is tried
 * once more at half the rate.
 */
export async function compressVideo(src: string, dest: string, bytes: number, given?: string): Promise<CompressResult> {
  let ffmpeg: string;
  try {
    ffmpeg = given ?? (await ensureFfmpeg());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const probe = await run(ffmpeg, ["-hide_banner", "-i", src], 30_000);
  const seconds = durationOf(probe.stderr);
  if (!seconds) return { ok: false, error: "ffmpeg could not read the video's length; open the file instead." };
  const tmp = path.join(os.tmpdir(), `studio-video-${process.pid}-${Date.now()}.mp4`);
  try {
    for (const share of [1, 0.5]) {
      const bps = Math.floor(videoBitrate(bytes, seconds) * share);
      const w = widthFor(bps);
      const r = await run(ffmpeg, [
        "-hide_banner", "-loglevel", "error", "-y", "-i", src,
        "-vf", `scale='min(${w},iw)':-2`, "-c:v", "libx264", "-preset", "veryfast",
        "-b:v", String(bps), "-maxrate", String(Math.floor(bps * 1.2)), "-bufsize", String(bps * 2),
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ac", "2", "-movflags", "+faststart", tmp,
      ], 10 * 60_000);
      if (r.code !== 0) return { ok: false, error: `ffmpeg could not compress the video: ${r.stderr.trim().split(/\r?\n/).pop() || `exit ${r.code}`}` };
      const size = fs.statSync(tmp).size;
      if (size <= bytes) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(tmp, dest);
        return { ok: true, bytes: size };
      }
    }
    return { ok: false, error: "The video is too long to fit a playable copy; open the file instead." };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
