/**
 * Smaller copies of videos a message carried, so one too large to play in the
 * chat still plays there. The encoder is ffmpeg, when this computer has it:
 * STUDIO_FFMPEG names one, else the first ffmpeg on PATH or in WinGet's links
 * folder. Without it the chat offers the file itself and says how to get one.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const EXE = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

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
  found = named ?? dirs.map((d) => path.join(d, EXE)).find((p) => fs.existsSync(p)) ?? null;
  return found;
}

/** Forget what findFfmpeg found, for a user who installs ffmpeg while Studio runs, and for tests. */
export function forgetFfmpeg(): void {
  found = undefined;
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
export async function compressVideo(src: string, dest: string, bytes: number, ffmpeg = findFfmpeg()): Promise<CompressResult> {
  if (!ffmpeg) return { ok: false, error: "No video encoder: install ffmpeg on this computer (winget install ffmpeg), then try again." };
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
