// Drive every playtest state against a live editor and screenshot the UI in each.
//
// Only with the user's go-ahead for editor use, and only on the StudioE2E test project:
//
//   npm run build -w @ue-mcp-studio/shared -w @ue-mcp-studio/client-web -w @ue-mcp-studio/agent
//   UE_MCP_EXTENSIONS_DIR=<scratch>/ext node scripts/install-dev.mjs        (stages the dev agent outside ~/.ue-mcp)
//   node scripts/visual-qa-live.mjs --project <StudioE2E.uproject> --extensions <scratch>/ext --out <dir> --editor-approved
//
// The StudioE2E editor must already be running and idle, with no other agent using it, and
// its open level must have a player Character (L_Playtest does). The script starts its own
// daemon for the project with the staged dev agent (discovery under <out>/daemons, so no
// other client finds it), checks that the daemon is attached to StudioE2E and to nothing
// else, and aborts otherwise. Then, through ue-mcp and Studio's own routes, it:
//
//   - saves three scripts under /Game/StudioVisualQA: a long one, a manual-only one and one that fails fast
//   - draft:              the long script's card in a new session, before it runs
//   - waiting:            a verdict on the manual script's draft, which starts its manual run
//   - armed, running:     Start Playtest on the long script, shot as it arms and once a step runs
//   - stopped:            pie(script_stop) on that run
//   - finished-failures:  the failing script run to its end with a Fail on its manual step
//   - loop-running, loop-needs-you: Assign to subagent on the failed run, whose failed manual
//                          step stops the loop for the user
//   - page-needs-you, page-failing, page-all: the Playtests page under each filter
//
// Each is shot in every theme at 1280 and 380 pixels through the dev UI (Vite proxied to that
// daemon). Afterwards it deletes the sessions and scripts it made and the runs' observation
// and recording folders, and stops its daemon. A failure on
// the way still runs the cleanup. Several live playtests in one session is covered by the
// stubbed runner (scripts/visual-qa.mjs), since PIE runs one script at a time.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (!process.argv.includes("--editor-approved")) throw new Error("drives a live editor: pass --editor-approved once the user has asked for editor runs");
const uproject = path.resolve(arg("project") ?? "");
if (!/studioe2e\.uproject$/i.test(uproject) || !fs.existsSync(uproject)) throw new Error("--project must be the StudioE2E test project's .uproject");
const extensions = path.resolve(arg("extensions") ?? "");
if (!fs.existsSync(path.join(extensions, "studio", "dist", "index.js"))) throw new Error("--extensions must hold the staged dev agent (see the header)");
const out = path.resolve(arg("out") ?? path.join(os.tmpdir(), "studio-visual-qa-live"));
const browserPath = [arg("browser"), process.env.STUDIO_QA_BROWSER, path.join(os.homedir(), "AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe"), "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean).find((p) => fs.existsSync(p));
if (!browserPath) throw new Error("no Chrome found: pass --browser <path>");
fs.mkdirSync(out, { recursive: true });

const projectDir = path.dirname(uproject);
const env = { ...process.env, UE_MCP_EXTENSIONS_DIR: extensions, UE_MCP_DAEMON_DIR: path.join(out, "daemons"), UE_MCP_DISABLE_UPDATE_CHECK: "1" };
Object.assign(process.env, { UE_MCP_DAEMON_DIR: env.UE_MCP_DAEMON_DIR, STUDIO_PROJECT: uproject });
const cli = path.join(root, "apps", "agent", "node_modules", "ue-mcp", "dist", "index.js");
const opened = spawnSync(process.execPath, [cli, "daemon", "open", "--json", uproject], { env, encoding: "utf-8" });
const url = new URL(JSON.parse(opened.stdout.slice(opened.stdout.indexOf("{"))).url);
const base = `http://127.0.0.1:${url.port}`;
const token = url.searchParams.get("token");
const auth = { authorization: `Bearer ${token}` };

async function http(method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const studio = (method, p, body) => http(method, `/v1/ext/studio${p}`, body);

const health = await http("GET", "/v1/health");
const editors = health.editors ?? [];
if (!/studioe2e$/i.test(health.projectRoot) || editors.length !== 1 || !editors[0].connected || !/studioe2e/i.test(editors[0].name)) {
  await http("POST", "/v1/shutdown").catch(() => {});
  throw new Error(`the daemon is not attached to the StudioE2E editor alone: ${JSON.stringify(editors)}`);
}

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const mcp = new Client({ name: "studio-visual-qa-live", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/mcp`), { requestInit: { headers: auth } }));
async function ue(category, action, args = {}) {
  const r = await mcp.callTool({ name: category, arguments: { action, ...args } });
  const text = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  const body = (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })();
  if (r.isError || body.success === false) throw new Error(`${category}(${action}): ${text}`);
  return body;
}

const DIR = "/Game/StudioVisualQA";
const jump = (within) => ({ instruction: "Press jump and the character leaves the ground", judge: "auto", resolve_in_pie: true, expect: { value: "JumpCurrentCount", op: "gt", target: 0, within_ms: within } });
const SCRIPTS = {
  long: { name: "SVQA_Long", steps: [jump(120000), { instruction: "The jump arc looks right", judge: "manual" }, jump(120000)] },
  manual: { name: "SVQA_Manual", manual_only: true, steps: [{ instruction: "The door opens without a visible pop", judge: "manual" }, { instruction: "The hinge sounds right", judge: "manual" }, { instruction: "The light changes as it opens", judge: "manual" }] },
  fails: { name: "SVQA_Fails", steps: [jump(300), { instruction: "The landing looks right", judge: "manual" }] },
};

const made = { sessions: new Set(), scripts: [], runs: new Set() };
const until = async (what, f, ms = 90_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const status = async (runId) => (await studio("GET", `/qa/runs/${encodeURIComponent(runId)}/status`)).run;
const card = async (script) => {
  const { run } = await studio("POST", "/qa/playtests/card", { script });
  made.sessions.add(run.sessionId);
  return run;
};

const { createServer } = await import("vite");
const { chromium } = await import("playwright-core");
const vite = await createServer({ root: path.join(root, "apps", "client-web"), configFile: path.join(root, "apps", "client-web", "vite.config.ts"), server: { port: 0 }, logLevel: "warn" });
await vite.listen();
const ui = vite.resolvedUrls.local[0].replace(/\/$/, "");
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const index = ["# Playtests visual QA against StudioE2E", "", `Rendered ${new Date().toISOString()} against a live daemon and editor.`, ""];

async function shoot(name, title, hash, filter) {
  index.push(`## ${name}`, "", title, "");
  for (const theme of ["ue-mcp", "editor-orange", "editor"]) for (const [label, width] of [["wide", 1280], ["narrow", 380]]) {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    if (filter) await page.addInitScript((f) => localStorage.setItem("studio.playtests.filter", f), filter);
    await page.goto(`${ui}/${hash}`);
    await page.waitForTimeout(2500);
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(300);
    const file = `${name}-${theme}-${label}.png`;
    await page.screenshot({ path: path.join(out, file), animations: "disabled" });
    index.push(`- [${theme}, ${label}](${file})`);
    await page.close();
  }
  index.push("");
  console.log(`shot ${name}`);
}

try {
  for (const s of Object.values(SCRIPTS)) {
    const saved = await ue("pie", "script_create", { path: `${DIR}/${s.name}`, ...s });
    made.scripts.push(saved.path ?? `${DIR}/${s.name}`);
  }
  const [long, manual, fails] = made.scripts;

  const draft = await card(long);
  await shoot("draft", "A draft card, before it runs", `#/chat/${draft.sessionId}`);

  const m = await card(manual);
  const waiting = (await studio("POST", `/qa/runs/${encodeURIComponent(m.runId)}/verdict`, { step: 0, verdict: "pass" })).run;
  made.runs.add(waiting.runId);
  await shoot("waiting", "A manual run waiting for verdicts, on the strip", `#/chat/${m.sessionId}`);

  const armed = (await studio("POST", `/qa/runs/${encodeURIComponent(draft.runId)}/run`, { startPie: true, players: 1, listen: false, record: true })).run;
  made.runs.add(armed.runId);
  await shoot("armed", "Start Playtest pressed: the run arms", `#/chat/${draft.sessionId}`);
  await until("a running step", async () => (await status(armed.runId))?.steps.some((s) => s.status === "running"));
  await shoot("running", "Running: a live card on the strip", `#/chat/${draft.sessionId}`);
  await ue("pie", "script_stop", { run_id: armed.runId, reason: "visual QA" });
  await until("the stop", async () => (await status(armed.runId))?.state === "stopped");
  await shoot("stopped", "Stopped: back in the transcript", `#/chat/${draft.sessionId}`);

  const f = await card(fails);
  const failing = (await studio("POST", `/qa/runs/${encodeURIComponent(f.runId)}/run`, { startPie: true, players: 1, listen: false, record: false })).run;
  made.runs.add(failing.runId);
  await until("the manual step's turn", async () => (await status(failing.runId))?.steps.some((s) => s.status === "awaiting_verdict"));
  await studio("POST", `/qa/runs/${encodeURIComponent(failing.runId)}/verdict`, { step: 1, verdict: "fail", note: "Visual QA: the landing pops" });
  await until("the end of the run", async () => (await status(failing.runId))?.state === "finished");
  await shoot("finished-failures", "Finished with failures", `#/chat/${f.sessionId}`);

  await studio("POST", `/qa/runs/${encodeURIComponent(failing.runId)}/assign`, {});
  await shoot("loop-running", "An assigned loop running", `#/chat/${f.sessionId}`);
  await until("the loop to stop for the user", async () => {
    const all = (await studio("GET", "/qa/playtests")).playtests;
    return all.find((e) => e.script === fails)?.card?.assignment?.loop?.state === "needs_you";
  }, 300_000);
  await shoot("loop-needs-you", "A loop that needs the user", `#/chat/${f.sessionId}`);

  for (const filter of ["needs-you", "failing", "all"]) await shoot(`page-${filter}`, `The Playtests page, ${filter}`, "#/playtests", filter);
} finally {
  const cleanup = async (what, f) => { try { await f(); } catch (e) { console.warn(`cleanup: ${what}: ${e.message}`); } };
  for (const p of made.scripts) await cleanup(`script ${p}`, () => ue("pie", "script_delete", { path: p, confirm: true }));
  for (const id of made.sessions) await cleanup(`session ${id}`, () => studio("DELETE", `/sessions/${encodeURIComponent(id)}`));
  for (const id of made.runs) {
    for (const dir of ["MCPObservations", "MCPRecordings"]) await cleanup(`${dir}/${id}`, async () => fs.rmSync(path.join(projectDir, "Saved", dir, id), { recursive: true, force: true }));
  }
  fs.writeFileSync(path.join(out, "index.md"), index.join("\n"));
  await cleanup("browser", () => browser.close());
  await cleanup("vite", () => vite.close());
  await cleanup("mcp", () => mcp.close());
  await cleanup("daemon", () => http("POST", "/v1/shutdown"));
}
