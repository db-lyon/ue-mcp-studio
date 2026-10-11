/**
 * Experimental: the Claude runtime the Agent SDK drives, fetched on first use.
 * It is the SDK's own platform package from npm, checked against the
 * registry's integrity hash and kept under Studio's folder per version, so a
 * Studio install needs neither Claude Code nor the package shipped beside it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";

declare const __CLAUDE_SDK_VERSION__: string | undefined;

const REGISTRY = "https://registry.npmjs.org";
const BINARY = process.platform === "win32" ? "claude.exe" : "claude";
const platformPackage = () => `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;

/** The SDK version the bundle was built with; the runtime must match it. */
export function runtimeVersion(): string | null {
  if (typeof __CLAUDE_SDK_VERSION__ === "string") return __CLAUDE_SDK_VERSION__;
  try {
    const main = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
    return JSON.parse(fs.readFileSync(path.join(path.dirname(main), "package.json"), "utf-8")).version;
  } catch {
    return null;
  }
}

export const runtimeDir = (version: string): string =>
  path.join(process.env.STUDIO_CLAUDE_RUNTIME_DIR || path.join(os.homedir(), ".ue-mcp", "studio", "runtime"), version);

/** The runtime when it is already here: fetched before, or the platform package beside a dev build. */
export function installedRuntime(): string | null {
  const version = runtimeVersion();
  if (version) {
    const fetched = path.join(runtimeDir(version), BINARY);
    if (fs.existsSync(fetched)) return fetched;
  }
  try {
    const pkg = createRequire(import.meta.url).resolve(`${platformPackage()}/package.json`);
    const exe = path.join(path.dirname(pkg), BINARY);
    return fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** One file out of a tar archive, by its path inside it. Handles ustar prefixes and pax path records. */
export function extractFromTar(tar: Buffer, wanted: string): Buffer | null {
  let off = 0;
  let paxPath: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) return null;
    const str = (a: number, b: number) => header.subarray(a, b).toString("utf-8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = str(156, 157);
    const prefix = str(345, 500);
    const name = paxPath ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    paxPath = null;
    if (type === "x") {
      const m = body.toString("utf-8").match(/\d+ path=([^\n]+)\n/);
      paxPath = m ? m[1] : null;
    } else if ((type === "0" || type === "") && name === wanted) {
      return Buffer.from(body);
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

let inflight: Promise<string> | null = null;

/** The runtime's path, fetching it first when it is not here. */
export function ensureRuntime(fetchImpl: typeof fetch = fetch): Promise<string> {
  const here = installedRuntime();
  if (here) return Promise.resolve(here);
  inflight ??= fetchRuntime(fetchImpl).finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function fetchRuntime(fetchImpl: typeof fetch): Promise<string> {
  const version = runtimeVersion();
  if (!version) throw new Error("This Studio build does not say which Claude runtime it needs.");
  const meta = await fetchImpl(`${REGISTRY}/${platformPackage()}/${version}`);
  if (!meta.ok) throw new Error(`No Claude runtime for ${process.platform}-${process.arch} (${meta.status}).`);
  const { dist } = (await meta.json()) as { dist: { tarball: string; integrity: string } };
  const res = await fetchImpl(dist.tarball);
  if (!res.ok) throw new Error(`Downloading the Claude runtime failed (${res.status}).`);
  const tgz = Buffer.from(await res.arrayBuffer());
  const [algo, expected] = dist.integrity.split("-", 2);
  if (crypto.createHash(algo).update(tgz).digest("base64") !== expected) throw new Error("The Claude runtime download did not match its published hash.");
  const binary = extractFromTar(await promisify(zlib.gunzip)(tgz), `package/${BINARY}`);
  if (!binary) throw new Error("The Claude runtime package has no binary for this platform.");
  const dir = runtimeDir(version);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${BINARY}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, binary, { mode: 0o755 });
  fs.renameSync(tmp, path.join(dir, BINARY));
  return path.join(dir, BINARY);
}
