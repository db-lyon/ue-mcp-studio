import * as path from "node:path";
const root = path.resolve(".");
const web = path.join(root, "apps", "client-web");
const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");
const s = await createServer({ root: web, configFile: path.join(web, "vite.config.ts"), server: { port: 0 }, logLevel: "warn" });
await s.listen();
const base = s.resolvedUrls.local[0].replace(/\/$/, "");
const b = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const p = await b.newPage({ viewport: { width: 390, height: 3200 }, hasTouch: true });
const [scenario, click, expr] = process.argv.slice(2);
await p.goto(`${base}/visual-qa.html?scenario=${scenario}&theme=ue-mcp&remote=1`);
await p.waitForSelector(".app"); await p.waitForTimeout(1200);
console.log("before", await p.evaluate(() => matchMedia("(pointer: coarse)").matches)); if (click) { await p.click(click); await p.mouse.move(1, 1); await p.waitForTimeout(800); }
console.log(JSON.stringify(await p.evaluate(expr), null, 1));
await b.close(); await s.close();
