// Draw the mobile app's icons and splash mark from Studio's mark: the orange
// ring with "UE" in Plus Jakarta Sans, as the store icon and the web client
// draw it. Writes apps/mobile/assets: icon.png (the full icon, rounded square),
// android-icon-foreground.png (the mark inside the adaptive icon's safe zone),
// android-icon-monochrome.png (the same in white, for themed icons),
// splash-icon.png (the mark alone, for the splash screen).
//
//   node scripts/mobile-icons.mjs [--browser <chrome.exe>]
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "apps", "mobile", "assets");
const font = path.join(root, "node_modules", "@expo-google-fonts", "plus-jakarta-sans", "700Bold", "PlusJakartaSans_700Bold.ttf");
const browserPath = [process.argv.includes("--browser") ? process.argv[process.argv.indexOf("--browser") + 1] : null, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"), "/usr/bin/google-chrome"].find((p) => p && fs.existsSync(p));
const { chromium } = await import("playwright-core");

const BG = "#0c0c0b";
const ACCENT = "#e8720c";
const TEXT = "#ece9e3";

/** The mark centred in a size x size square: the ring `ring` wide, "UE" inside. */
const mark = (size, ring, color = ACCENT, text = TEXT) => {
  const r = ring / 2;
  const stroke = ring * 0.072;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${size / 2}" cy="${size / 2}" r="${r - stroke / 2}" fill="none" stroke="${color}" stroke-width="${stroke}"/>
  <text x="${size / 2}" y="${size / 2}" dy="0.355em" text-anchor="middle" font-family="Mark" font-weight="700" font-size="${ring * 0.4}" letter-spacing="${ring * 0.004}" fill="${text}">UE</text>
</svg>`;
};

const page = (body, size, background = "transparent") => `<!doctype html><html><head><style>
@font-face { font-family: "Mark"; src: url("data:font/ttf;base64,${fs.readFileSync(font).toString("base64")}") format("truetype"); }
html, body { margin: 0; width: ${size}px; height: ${size}px; background: ${background}; overflow: hidden; }
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch({ executablePath: browserPath, headless: true });
async function shoot(file, html, size) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(html);
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: path.join(assets, file), omitBackground: true });
  await p.close();
  console.log(`wrote ${file}`);
}

// The full icon: the mark on a near-black square; iOS rounds the corners itself and refuses transparency.
await shoot("icon.png", page(`<div style="width:1024px;height:1024px;background:${BG};position:relative">${mark(1024, 784)}</div>`, 1024), 1024);
// Adaptive icon layers: 108dp canvas, 66dp safe circle. The ring fills 58% of the canvas, inside the safe zone.
await shoot("android-icon-foreground.png", page(mark(1024, 594), 1024), 1024);
await shoot("android-icon-monochrome.png", page(mark(1024, 594, "#ffffff", "#ffffff"), 1024), 1024);
// The splash mark: Android 12+ crops the splash icon to a circle two thirds of its size.
await shoot("splash-icon.png", page(mark(1024, 620), 1024), 1024);
await browser.close();
