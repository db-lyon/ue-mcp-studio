// Measure Settings > Agents' subagent and skill rows in headless Chrome, where react-native-web lays them
// out for real, at phone widths:
//
//   node scripts/agents-rows-layout.mjs [--widths 360,390] [--out <dir>] [--browser <chrome.exe>]
//
// Each row must give its description the row's full width, and draw Open file 28 to 32 px tall: at the end
// of the name line when the name leaves room for it, otherwise under the description. Exits 1 on a breach,
// and writes a screenshot per width and theme to <out>.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const widths = (arg("widths") ?? "360,390").split(",").map(Number);
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-agents-rows"));
const browserPath = [arg("browser"), process.env.STUDIO_QA_BROWSER, path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"), "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"]
  .filter(Boolean)
  .find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("no Chrome or Edge found: pass --browser <path> or set STUDIO_QA_BROWSER");

const { chromium } = await import("playwright-core");
const { mobileQaServer } = await import("./mobile-qa-server.mjs");
const server = await mobileQaServer(root);
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
fs.mkdirSync(out, { recursive: true });

const failures = [];
for (const width of widths) {
  for (const theme of ["ue-mcp", "editor"]) {
    const page = await browser.newPage({ viewport: { width, height: 2600 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
    await page.goto(`${base}/index.html?scenario=settings-agents-long&theme=${theme}`);
    await page.waitForSelector('[data-testid="agent-file-row"]', { timeout: 60_000 });
    await page.waitForTimeout(1500);
    const rows = await page.$$eval('[data-testid="agent-file-row"]', (els) =>
      els.map((row) => {
        const r = row.getBoundingClientRect();
        const nameLine = row.querySelector('[data-testid="agent-file-name"]');
        const button = row.querySelector('[aria-label^="Open "]');
        const description = nameLine.nextElementSibling;
        const n = nameLine.getBoundingClientRect();
        const b = button.getBoundingClientRect();
        const d = description.getBoundingClientRect();
        const name = nameLine.firstElementChild.getBoundingClientRect();
        return {
          label: button.getAttribute("aria-label"),
          rowLeft: r.left, rowRight: r.right,
          descLeft: d.left, descRight: d.right, descBottom: d.bottom,
          button: { top: b.top, bottom: b.bottom, left: b.left, right: b.right, height: b.height },
          inline: nameLine.contains(button),
          nameRight: name.right, nameLineHeight: n.height,
        };
      }),
    );
    const at = `${width}px ${theme}`;
    for (const row of rows) {
      const where = `${at} ${row.label}`;
      const full = row.rowRight - row.rowLeft;
      if (row.descRight - row.descLeft < full - 1) failures.push(`${where}: description ${Math.round(row.descRight - row.descLeft)} px of a ${Math.round(full)} px row`);
      if (row.button.height < 28 || row.button.height > 32) failures.push(`${where}: Open file ${row.button.height} px tall`);
      if (row.inline) {
        if (Math.abs(row.button.right - row.rowRight) > 1) failures.push(`${where}: Open file not at the end of the name line`);
        if (row.nameRight > row.button.left) failures.push(`${where}: the name runs under Open file`);
        if (row.nameLineHeight > 32) failures.push(`${where}: the name wraps beside Open file (${row.nameLineHeight} px)`);
      } else if (row.button.top < row.descBottom) failures.push(`${where}: Open file is not under the description`);
    }
    if (!rows.some((r) => r.inline)) failures.push(`${at}: no row keeps Open file on its name line`);
    if (!rows.some((r) => !r.inline)) failures.push(`${at}: the long name's row keeps Open file on its line`);
    console.log(`${at}: ${rows.map((r) => `${r.label.replace(/^Open /, "")} ${r.inline ? "inline" : "below"}`).join(", ")}`);
    await page.screenshot({ path: path.join(out, `agents-rows-${width}-${theme}.png`), fullPage: true });
    await page.close();
  }
}
await browser.close();
await server.close();
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: ${out}`);
