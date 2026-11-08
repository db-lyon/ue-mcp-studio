#!/usr/bin/env node
/**
 * Build apps/installer/dist/UE-MCP-Studio-Setup.exe, the Windows installer
 * that runs `npx ue-mcp install studio` for a project the user picks
 * (apps/installer/setup.iss). Inno Setup comes from its GitHub release,
 * pinned by version and SHA-256, and is kept in apps/installer/.deps.
 *
 * Signing: set STUDIO_SIGNTOOL to a command line with $f where the file
 * goes, e.g. `signtool sign /fd sha256 /tr <timestamp url> /td sha256 /a $f`.
 * Unset, the installer is built unsigned.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "apps", "installer");
const DEPS = path.join(APP, ".deps");
const ART = path.join(APP, "build");
const OUT = path.join(APP, "dist");
const INSTALLER_NAME = "UE-MCP-Studio-Setup.exe";
const INNO = {
  version: "6.7.4",
  url: "https://github.com/jrsoftware/issrc/releases/download/is-6_7_4/innosetup-6.7.4.exe",
  sha256: "a549929319f9120716677c685535ca4671e4b937b5fdc87e2585f32d8eb30e8c",
};

/** ISCC.exe of the pinned Inno Setup, unpacked once into .deps as a portable install. */
async function iscc() {
  const dir = path.join(DEPS, `innosetup-${INNO.version}`);
  const exe = path.join(dir, "ISCC.exe");
  if (fs.existsSync(exe)) return exe;
  const res = await fetch(INNO.url);
  if (!res.ok) throw new Error(`downloading Inno Setup answered ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = crypto.createHash("sha256").update(bytes).digest("hex");
  if (got !== INNO.sha256) throw new Error(`the Inno Setup download does not match its pinned SHA-256 (${got})`);
  fs.mkdirSync(DEPS, { recursive: true });
  const setup = path.join(DEPS, `innosetup-${INNO.version}.exe`);
  fs.writeFileSync(setup, bytes);
  const r = spawnSync(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/PORTABLE=1", "/NOICONS", `/DIR=${dir}`], { stdio: "inherit" });
  fs.rmSync(setup, { force: true });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error(`unpacking Inno Setup failed (${r.status})`);
  return exe;
}

/**
 * Studio's mark, as studio-window.exe draws it (makeIcon in apps/window/src/main.cpp):
 * a dark rounded tile with an orange dot. RGBA rows, `size` pixels square, centred in w x h.
 */
function mark(size, w = size, h = size, top = (h - size) / 2) {
  const px = Buffer.alloc(w * h * 4);
  const left = (w - size) / 2;
  const c = (size - 1) / 2, dot = size * 0.26, tile = size * 0.5, radius = size * 0.18;
  const clamp = (v) => Math.min(1, Math.max(0, v));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mx = x - left, my = y - top;
      const qx = Math.max(Math.abs(mx - c) - (tile - radius), 0), qy = Math.max(Math.abs(my - c) - (tile - radius), 0);
      const tileA = clamp(radius - Math.hypot(qx, qy) + 0.5);
      const dotA = clamp(dot - Math.hypot(mx - c, my - c) + 0.5);
      const i = (y * w + x) * 4;
      px[i] = 0x13 + (0xe8 - 0x13) * dotA;
      px[i + 1] = 0x13 + (0x72 - 0x13) * dotA;
      px[i + 2] = 0x12 + (0x0c - 0x12) * dotA;
      px[i + 3] = tileA * 255;
    }
  }
  return { w, h, px };
}

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function png({ w, h, px }) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico of PNG entries, which Windows Vista and later read at every size. */
function ico(sizes) {
  const images = sizes.map((s) => png(mark(s)));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    head[e] = s >= 256 ? 0 : s;
    head[e + 1] = s >= 256 ? 0 : s;
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(images[i].length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}

/** The icon and wizard images, one file per DPI step Inno Setup picks from. */
function art() {
  fs.rmSync(ART, { recursive: true, force: true });
  fs.mkdirSync(ART, { recursive: true });
  fs.writeFileSync(path.join(ART, "studio.ico"), ico([16, 20, 24, 32, 40, 48, 64, 256]));
  const large = [], small = [];
  for (const scale of [1, 1.25, 1.5, 2]) {
    const w = Math.round(164 * scale), h = Math.round(314 * scale), s = Math.round(55 * scale);
    const l = path.join(ART, `wizard-${w}.png`);
    fs.writeFileSync(l, png(mark(Math.round(88 * scale), w, h, Math.round(96 * scale))));
    large.push(l);
    const m = path.join(ART, `small-${s}.png`);
    fs.writeFileSync(m, png(mark(s)));
    small.push(m);
  }
  return { icon: path.join(ART, "studio.ico"), large: large.join(","), small: small.join(",") };
}

if (process.platform !== "win32") {
  console.log(`${INSTALLER_NAME} is built on Windows only; skipped`);
  process.exit(0);
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;
if (!/^[0-9A-Za-z.-]+$/.test(version)) throw new Error(`unexpected version ${version}`);
const compiler = await iscc();
const images = art();
fs.mkdirSync(OUT, { recursive: true });
const args = [
  `/DAppVersion=${version}`,
  `/DNumericVersion=${version.split("-")[0]}`,
  `/DIconFile=${images.icon}`,
  `/DWizardImages=${images.large}`,
  `/DWizardSmallImages=${images.small}`,
  `/O${OUT}`,
  `/F${INSTALLER_NAME.replace(/\.exe$/, "")}`,
  "/Qp",
];
const sign = process.env.STUDIO_SIGNTOOL;
if (sign) args.push("/DSign", `/Sstudio=${sign}`);
const r = spawnSync(compiler, [...args, path.join(APP, "setup.iss")], { stdio: "inherit" });
if (r.status !== 0) throw new Error(`ISCC failed (${r.status})`);
console.log(`${path.join(OUT, INSTALLER_NAME)}${sign ? " (signed)" : " (unsigned)"}`);
