#!/usr/bin/env node
/**
 * Studio against Claude Code on the same Unreal work, repeated, with task checks. See README.md.
 *
 * node scripts/usage-parity/measure.mjs --project <path to .uproject> [--rounds 3] [--prompts A,B,C,D,E]
 *   [--base <git ref>] [--model claude-sonnet-5-5] [--effort medium] [--no-cc] [--no-warm] [--keep]
 *   [--strategies micro,lean,full] [--measurement <file>]
 *
 * --strategies runs Studio once per ue-mcp context strategy; --measurement writes the runs in
 * ue-mcp's ContextMeasurement format.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanup, connect, ensureBaseline, preflight, reset, verify } from "./editor.mjs";
import { report, spend } from "./report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);
const uproject = opt("project");
if (!uproject || !fs.existsSync(uproject)) {
  console.error("usage: node scripts/usage-parity/measure.mjs --project <path to .uproject> [--rounds 3] [--prompts A,B,C,D,E] [--base <git ref>] [--model m] [--effort e] [--no-cc] [--no-warm] [--keep] [--strategies micro,lean,full] [--measurement <file>]");
  process.exit(2);
}
const rounds = Number(opt("rounds", "3"));
const promptIds = opt("prompts", "A,B,C,D,E").split(",");
const model = opt("model", "claude-sonnet-5-5");
const effort = opt("effort", "medium");
const baseRef = opt("base", null);
const strategies = opt("strategies", null)?.split(",").filter((s) => ["micro", "lean", "full"].includes(s)) ?? null;
const measurementFile = opt("measurement", null);
const projectDir = path.dirname(path.resolve(uproject));
const ueMcp = path.join(repo, "apps", "agent", "node_modules", "ue-mcp", "dist", "index.js");
const promptsFile = path.join(here, "prompts.json");
const prompts = JSON.parse(fs.readFileSync(promptsFile, "utf8"));
for (const p of promptIds) if (!prompts[p]) throw new Error(`no prompt ${p} in prompts.json`);

// Both clients write their conversations where Claude Code keeps a project's, which is what the cost is read from.
const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const transcriptDir = path.join(claudeHome, "projects", projectDir.replace(/[:\\/]/g, "-"));
const work = path.join(repo, "apps", "agent", ".usage-parity");
const runDir = path.join(work, new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(runDir, { recursive: true });
const resultsFile = path.join(runDir, "results.jsonl");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Bundle the harness against an agent source tree, exporting runner.ts's prompt builders. */
async function buildHarness(srcRoot, out) {
  const esbuild = await import("esbuild");
  const entry = path.join(srcRoot, "apps", "agent", "src", "__usage_parity_harness.ts");
  fs.copyFileSync(path.join(here, "harness.ts"), entry);
  try {
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "esm", target: "node20", outfile: out,
      external: ["@anthropic-ai/claude-agent-sdk", "@modelcontextprotocol/sdk"],
      alias: { "@ue-mcp-studio/shared": path.join(srcRoot, "packages", "shared", "src", "index.ts") },
      nodePaths: [path.join(repo, "node_modules"), path.join(repo, "apps", "agent", "node_modules")],
      define: { __CLAUDE_SIGN_IN__: "true" },
      banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" },
      logLevel: "warning",
      plugins: [{
        name: "export-prompts",
        setup(b) {
          b.onLoad({ filter: /[\\/]apps[\\/]agent[\\/]src[\\/]runner\.ts$/ }, (a) => ({ contents: `${fs.readFileSync(a.path, "utf8")}\nexport { system, subagentSystem };\n`, loader: "ts" }));
        },
      }],
    });
  } finally {
    fs.rmSync(entry, { force: true });
  }
}

const clients = [];
if (!flag("no-cc")) clients.push("cc");
await buildHarness(repo, path.join(work, "studio.mjs"));
// One Studio client per strategy when asked, all from the same bundle.
if (strategies) clients.push(...strategies.map((s) => `studio:${s}`));
else clients.push("studio");
if (baseRef) {
  const src = path.join(work, "base-src");
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  const tar = path.join(work, "base.tar");
  execFileSync("git", ["-C", repo, "archive", "-o", tar, baseRef, "apps/agent/src", "packages/shared/src"]);
  // Relative paths: GNU tar reads "C:" in a path as a remote host.
  execFileSync("tar", ["-xf", path.relative(src, tar)], { cwd: src });
  await buildHarness(src, path.join(work, "studio-base.mjs"));
  clients.push("studio-base");
}

if (flag("build-only")) {
  log(`built ${[...new Set(clients.filter((c) => c !== "cc").map((c) => c.replace(/:.*/, "")))].map((c) => path.join(work, `${c}.mjs`)).join(", ")}`);
  fs.rmSync(runDir, { recursive: true, force: true });
  process.exit(0);
}

const mcpConfig = path.join(runDir, "cc-mcp.json");
fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { "ue-mcp": { command: process.execPath, args: [ueMcp, path.resolve(uproject)] } } }));

const u = await connect(repo, ueMcp, path.resolve(uproject));
await preflight(u, uproject);
const current = await u.call("level", "get_current", {});
const openBefore = [current.levelPath, current.packageName, current.path, current.worldPath].find((p) => typeof p === "string" && p.startsWith("/Game/"))?.replace(/\.[^/]*$/, "") ?? null;
const shots = path.join(projectDir, "Saved", "Screenshots");
const listShots = () => (fs.existsSync(shots) ? fs.readdirSync(shots, { recursive: true }).map((f) => path.join(shots, String(f))) : []);
const shotsBefore = new Set(listShots());
const base = await ensureBaseline(u, work);
log(`clients ${clients.join(", ")}; prompts ${promptIds.join(",")}; ${rounds} rounds; ${model} ${effort}; results in ${runDir}`);

const snapshot = () => new Set(fs.existsSync(transcriptDir) ? fs.readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl")) : []);

async function runOne(client, pid, label) {
  await reset(u, base);
  // A per-run tag on the first message, so no run reads another run's conversation from the prompt cache.
  const nonce = Math.random().toString(36).slice(2, 8);
  const turns = (Array.isArray(prompts[pid]) ? prompts[pid] : [prompts[pid]]).map((t, i) => (i === 0 ? `${t}\n\n(run ${nonce})` : t));
  const before = snapshot();
  const t0 = Date.now();
  let rec;
  if (client === "cc") {
    let session = null;
    const finals = [];
    let error = null;
    for (const text of turns) {
      const args = ["-p", text, "--model", model, "--effort", effort, "--permission-mode", "bypassPermissions", "--strict-mcp-config", "--mcp-config", mcpConfig,
        "--setting-sources", "project,local", "--output-format", "json", ...(session ? ["--resume", session] : [])];
      const out = spawnSync("claude", args, { cwd: projectDir, encoding: "utf8", maxBuffer: 1 << 28, timeout: 40 * 60_000 });
      let res;
      try {
        res = JSON.parse(out.stdout);
        if (Array.isArray(res)) res = res.find((x) => x.type === "result") ?? res.at(-1);
      } catch {
        res = { is_error: true, result: (out.stderr || out.stdout || "").slice(0, 500) };
      }
      session = res.session_id ?? session;
      finals.push(res.result ?? "");
      if (res.is_error) error = String(res.result ?? "error").slice(0, 300);
    }
    rec = { error, finalText: finals.join("\n---\n") };
  } else {
    const before2 = fs.existsSync(path.join(runDir, "harness.jsonl")) ? fs.readFileSync(path.join(runDir, "harness.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
    const [bundle, strategy] = client.startsWith("studio:") ? ["studio", client.slice(7)] : [client, "micro"];
    const out = spawnSync(process.execPath, [path.join(work, `${bundle}.mjs`), promptsFile, pid, model, effort, label, path.resolve(uproject), ueMcp, path.join(runDir, "harness.jsonl"), path.join(runDir, "data"), nonce, strategy],
      { encoding: "utf8", maxBuffer: 1 << 26, timeout: 40 * 60_000 });
    const lines = fs.existsSync(path.join(runDir, "harness.jsonl")) ? fs.readFileSync(path.join(runDir, "harness.jsonl"), "utf8").split("\n").filter(Boolean) : [];
    rec = lines.length > before2 ? JSON.parse(lines.at(-1)) : { error: `harness failed: ${(out.stderr || out.stdout || "").slice(-500)}`, finalText: "" };
  }
  rec = { ...rec, client, label, prompt: pid, model, effort, nonce, wall: (Date.now() - t0) / 1000 };
  rec.files = [...snapshot()].filter((f) => !before.has(f)).map((f) => path.join(transcriptDir, f));
  rec.verify = await verify(u, base, pid, rec.finalText ?? "").catch((e) => ({ ok: false, error: String(e) }));
  rec.at = new Date().toISOString();
  fs.appendFileSync(resultsFile, `${JSON.stringify(rec)}\n`);
  log(client, pid, label, `${Math.round(rec.wall)}s`, rec.verify.ok ? "task ok" : `task FAILED ${JSON.stringify(rec.verify.failed ?? rec.verify.error).slice(0, 200)}`, rec.error ?? "");
}

try {
  // The first run of each client writes its fixed prefix to the prompt cache; it is not counted.
  if (!flag("no-warm")) for (const c of clients) await runOne(c, "A", "warm");
  for (let i = 0; i < rounds; i++) {
    for (const p of promptIds) for (const c of i % 2 ? [...clients].reverse() : clients) await runOne(c, p, "measured");
  }
} finally {
  if (!flag("keep")) {
    await reset(u, base).catch(() => undefined);
    await cleanup(u, openBefore).catch((e) => log("cleanup failed:", e.message));
    for (const f of listShots()) if (!shotsBefore.has(f) && /\.(png|jpe?g|bmp|exr)$/i.test(f)) fs.rmSync(f, { force: true });
  }
  await u.close();
}

const runs = fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.label === "measured");
const text = report(runs);
fs.writeFileSync(path.join(runDir, "report.md"), text);
if (measurementFile && strategies) {
  // ue-mcp's ContextMeasurement: one run per strategy, every measured task with what it spent and whether its checks passed.
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "apps", "agent", "node_modules", "ue-mcp", "package.json"), "utf8"));
  const measurement = {
    version: 1,
    measuredAt: new Date().toISOString(),
    ueMcpVersion: pkg.version,
    client: { name: "ue-mcp-studio", version: JSON.parse(fs.readFileSync(path.join(repo, "apps", "agent", "package.json"), "utf8")).version },
    runs: strategies.map((s) => {
      const mine = runs.filter((r) => r.client === `studio:${s}`);
      return {
        model: { vendor: "anthropic", model },
        scope: "9+",
        strategy: s,
        seedTokens: mine.find((r) => r.seedTokens)?.seedTokens ?? 0,
        tasks: mine.map((r, i) => {
          const sp = spend(r.files ?? []);
          return { id: `${r.prompt}-${i}`, totalTokens: sp.input + sp.write5m + sp.write1h + sp.read + sp.output, modelCalls: sp.calls, discoveryCalls: sp.ue.search + sp.ue.describe + (sp.results.catalog?.n ?? 0), passed: !!r.verify?.ok };
        }),
      };
    }),
  };
  fs.writeFileSync(measurementFile, `${JSON.stringify(measurement, null, 2)}\n`);
  log(`measurement written to ${measurementFile}`);
}
console.log(`\n${text}\n\nWritten to ${path.join(runDir, "report.md")}`);
process.exit(0);
