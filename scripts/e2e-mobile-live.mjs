// The mobile app's real entry (apps/mobile/App.tsx) end to end in headless Chrome, at 390x844.
//
//   node scripts/e2e-mobile-live.mjs --project <name> [--out <dir>] [--skip-live] [--skip-fake] [--scenario tools-open --session "Door hinge fix"]
//
// Live: against https://remote.ue-mcp.com and the running daemon of the project whose root ends in
// <name> (its newest ~/.ue-mcp/daemons/*.json). The script asks that daemon for a pairing link, pastes
// it into the welcome screen, allows the pending approval whose label is this page's, opens the
// project and shots welcome, the code, the projects list and the project. A browser cannot call the
// relay itself (it checks Origin and sends no CORS), so the page's /relay is proxied to it here with
// the relay's own Origin, its session cookie passed through. Every phone this run paired is removed
// afterwards, from the daemon and from the relay, and the daemon's list is printed.
//
// Fake: the same entry against a relay and computer inside the page (apps/mobile/visual-qa/fake-relay.ts)
// answering from a web visual-qa scenario with no lock, already paired: the Chat tab, then a session.
import * as fs from "node:fs";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-mobile-e2e"));
const projectName = arg("project");
const scenario = arg("scenario") ?? "tools-open";
/** The session the scenario's daemon lists (tools-open's). */
const sessionTitle = arg("session") ?? "Door hinge fix";
const RELAY = new URL("https://remote.ue-mcp.com");
const LABEL = "E2E test (Studio app)";
const BROWSERS = [
  arg("browser"),
  process.env.STUDIO_QA_BROWSER,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const browserPath = BROWSERS.find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("no Chrome found: pass --browser <path> or set STUDIO_QA_BROWSER");
if (!flag("skip-live") && !projectName) throw new Error("pass --project <name> (the live project), or --skip-live");
fs.mkdirSync(out, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── The relay proxy ─────────────────────────────────────────────

/** What this run's phones redeemed: the relay's id for each, so they can be revoked there. */
const redeemed = [];

/** A Set-Cookie from the relay, made to stick to this page: no Domain, no Secure, Lax, its path under /relay. */
function localCookie(c) {
  return c
    .split(";")
    .map((p) => p.trim())
    .filter((p) => !/^(domain|secure|samesite|partitioned)\b/i.test(p))
    .map((p) => (/^path=/i.test(p) ? `Path=/relay${p.slice(5) === "/" ? "" : p.slice(5)}` : p))
    .concat("SameSite=Lax")
    .join("; ");
}

const relayProxy = {
  name: "relay-proxy",
  configureServer(server) {
    server.middlewares.use("/relay", (req, res) => {
      const headers = { ...req.headers, host: RELAY.host, origin: RELAY.origin };
      delete headers.referer;
      delete headers.connection;
      // Plain bodies, so the redeem answer can be read here.
      delete headers["accept-encoding"];
      const up = https.request({ host: RELAY.hostname, port: 443, method: req.method, path: req.url, headers }, (r) => {
        const h = { ...r.headers };
        if (h["set-cookie"]) h["set-cookie"] = h["set-cookie"].map(localCookie);
        res.writeHead(r.statusCode ?? 502, h);
        res.flushHeaders();
        if (req.url === "/api/pair/redeem") {
          const chunks = [];
          r.on("data", (d) => chunks.push(d));
          r.on("end", () => {
            try {
              const id = JSON.parse(Buffer.concat(chunks).toString()).deviceId;
              if (typeof id === "string") redeemed.push(id);
            } catch {}
          });
        }
        r.pipe(res);
      });
      up.on("error", (e) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `relay proxy: ${e.message}` }));
      });
      // The page let go of the call (a stream it stopped reading): stop the relay's too.
      res.on("close", () => {
        if (!res.writableFinished) up.destroy();
      });
      req.pipe(up);
    });
  },
};

// ── The daemon ──────────────────────────────────────────────────

function daemonFor(name) {
  const dir = path.join(os.homedir(), ".ue-mcp", "daemons");
  const found = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: path.join(dir, f), at: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .map(({ file }) => JSON.parse(fs.readFileSync(file, "utf8")))
    .find((d) => path.basename(String(d.projectRoot ?? "").replace(/[\\/]+$/, "")).toLowerCase() === name.toLowerCase());
  if (!found) throw new Error(`no daemon discovery file for a project named ${name}`);
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${found.port}/v1/ext/studio${p}`, {
      method,
      headers: { authorization: `Bearer ${found.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return { port: found.port, call };
}

// ── The page ────────────────────────────────────────────────────

const { chromium } = await import("playwright-core");
const { mobileQaServer } = await import("./mobile-qa-server.mjs");
const server = await mobileQaServer(root, { plugins: [relayProxy] });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const results = [];
const step = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};

async function openPage(query) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}/app.html${query}`);
  await page.waitForFunction(() => window.__e2eReady, null, { timeout: 120_000 }).catch((e) => {
    throw new Error(`the page did not start: ${e.message}${errors.length ? ` | page errors: ${errors.join(" | ")}` : ""}`);
  });
  return { context, page, errors };
}

/** The first visible element whose accessibility label (or, failing that, text) is `what`. */
async function visible(page, what, timeout = 30_000) {
  const label = what.replace(/"/g, '\\"');
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const h of await page.locator(`[aria-label="${label}"]`).all()) if (await h.isVisible().catch(() => false)) return h;
    for (const h of await page.getByText(what, { exact: true }).all()) if (await h.isVisible().catch(() => false)) return h;
    await page.waitForTimeout(250);
  }
  throw new Error(`nothing visible: ${what}`);
}

const shot = async (page, name) => {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file });
  log(`shot ${file}`);
};

// ── Live ────────────────────────────────────────────────────────

async function live() {
  const daemon = daemonFor(projectName);
  const status = await daemon.call("GET", "/remote/status");
  step("daemon remote status", status.body?.state === "online", JSON.stringify(status.body));
  const allowed = [];
  const { context, page, errors } = await openPage("");
  try {
    await visible(page, "Paste pairing link", 60_000);
    await page.waitForTimeout(500);
    await shot(page, "01-welcome");
    step("welcome screen", true);

    const pairing = await daemon.call("POST", "/remote/pair");
    if (pairing.status !== 200 || !pairing.body?.url) throw new Error(`pair: ${pairing.status} ${JSON.stringify(pairing.body)}`);
    step("pairing link from the daemon", true);
    // Paste opens the link panel (filled from the clipboard when it holds a link; this page's is empty).
    await (await visible(page, "Paste pairing link")).click();
    const input = await visible(page, "Pairing link");
    await input.fill(pairing.body.url);
    await (await visible(page, "Pair")).click();

    const codeEl = await page.waitForSelector('[aria-label^="Code "]', { timeout: 60_000 });
    const shown = (await codeEl.getAttribute("aria-label")).replace(/^Code\s*/, "").replace(/\s+/g, "");
    await page.waitForTimeout(400);
    await shot(page, "02-pairing-code");
    step("waiting with code", true, shown);

    let approval = null;
    for (let i = 0; i < 60 && !approval; i++) {
      const list = await daemon.call("GET", "/remote/approvals");
      approval = list.body?.approvals?.find((a) => a.label === LABEL && a.code.replace(/\s+/g, "") === shown) ?? null;
      if (!approval) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!approval) throw new Error("no pending approval with this page's label and code");
    const decided = await daemon.call("POST", `/remote/approvals/${encodeURIComponent(approval.id)}`, { allow: true });
    if (decided.status !== 200) throw new Error(`approve: ${decided.status} ${JSON.stringify(decided.body)}`);
    if (decided.body?.browser?.id) allowed.push(decided.body.browser.id);
    step("approval allowed", true, `browser ${decided.body?.browser?.id}`);

    await visible(page, "Choose the project to open in Studio.", 60_000);
    // The relay names a project "<project> on <computer>".
    const row = page.getByText(new RegExp(`^${projectName}( on .*)?$`, "i")).first();
    await row.waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(800);
    await shot(page, "03-projects");
    step("projects list", true);

    await row.click();
    await page.waitForSelector('[aria-label="PIN keypad"]', { state: "visible", timeout: 90_000 });
    await page.waitForTimeout(1000);
    await shot(page, "04-project-locked");
    step("locked project with keypad", true);
  } catch (e) {
    await shot(page, "live-failure").catch(() => undefined);
    step("live flow", false, `${e.message}${errors.length ? ` | page errors: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  } finally {
    // Remove every phone this run paired: from the daemon by id (and by this page's label), then from the relay.
    const before = await daemon.call("GET", "/remote/browsers");
    const mine = (before.body?.browsers ?? []).filter((b) => allowed.includes(b.id) || b.label === LABEL);
    for (const b of mine) {
      const r = await daemon.call("DELETE", `/remote/browsers/${encodeURIComponent(b.id)}`);
      log(`removed daemon browser ${b.id} (${b.label}): ${r.status}`);
    }
    // The relay's record of each: the ids this run redeemed, and any client left with this page's label.
    const viewers = await page
      .evaluate(async () => {
        const r = await fetch("/relay/api/devices", { credentials: "include", headers: { accept: "application/json" } });
        return r.ok ? ((await r.json()).viewers ?? []) : [];
      })
      .catch(() => []);
    // This page's own session last, since revoking it ends the session the others are revoked through.
    const current = viewers.find((v) => v.current)?.id;
    const revoke = [...new Set([...redeemed, ...viewers.filter((v) => v.label === LABEL).map((v) => v.id)])].sort((a, b) => (a === current) - (b === current));
    for (const id of revoke) {
      const r = await page.evaluate(async (id) => (await fetch(`/relay/viewers/${encodeURIComponent(id)}/revoke`, { method: "POST", credentials: "include" })).status, id).catch((e) => String(e));
      log(`revoked relay client ${id}: ${r}`);
    }
    const remaining = await page
      .evaluate(async () => {
        const r = await fetch("/relay/api/devices", { credentials: "include", headers: { accept: "application/json" } });
        return r.ok ? ((await r.json()).viewers ?? []) : null;
      })
      .catch(() => null);
    if (remaining) log(`relay clients now: ${remaining.map((v) => `${v.id} (${v.label})`).join(", ")}`);
    const after = await daemon.call("GET", "/remote/browsers");
    const left = after.body?.browsers ?? [];
    log(`daemon browsers now: ${left.map((b) => `${b.id} (${b.label})`).join(", ")}`);
    step("cleanup", !left.some((b) => allowed.includes(b.id) || b.label === LABEL), `created ${allowed.join(", ") || "none"}; relay ids ${redeemed.join(", ") || "none"}`);
    await context.close();
  }
}

// ── Fake ────────────────────────────────────────────────────────

async function fake() {
  const { context, page, errors } = await openPage(`?fake=${encodeURIComponent(scenario)}`);
  try {
    // Opens on the last project, past the projects list; no lock in the fixture.
    await page.waitForSelector('[aria-label="PIN keypad"]', { state: "visible", timeout: 8_000 }).then(
      () => {
        throw new Error("the fixture project is locked");
      },
      () => undefined,
    );
    const row = await visible(page, sessionTitle, 60_000);
    await page.waitForTimeout(1000);
    await shot(page, "05-fake-chat-sessions");
    step("fake: chat tab with sessions", true);
    await row.click();
    await page.waitForSelector("#transcript", { state: "visible", timeout: 30_000 });
    await page.waitForTimeout(1500);
    await shot(page, "06-fake-session-open");
    step("fake: a session open", true);
  } catch (e) {
    await shot(page, "fake-failure").catch(() => undefined);
    step("fake flow", false, `${e.message}${errors.length ? ` | page errors: ${errors.slice(0, 5).join(" | ")}` : ""}`);
  } finally {
    await context.close();
  }
}

try {
  if (!flag("skip-live")) await live();
  if (!flag("skip-fake")) await fake();
} finally {
  await browser.close();
  await server.close();
}
const failed = results.filter((r) => !r.ok);
log(`${results.length - failed.length}/${results.length} steps passed; shots in ${out}`);
process.exit(failed.length ? 1 : 0);
