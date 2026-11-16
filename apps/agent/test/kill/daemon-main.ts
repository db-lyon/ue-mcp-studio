/**
 * A stand-in daemon for the kill tests: Studio's AgentRunner on a fake editor
 * host, on one runtime, with a small HTTP control so the test in another
 * process can drive it and read what a client would see. The test kills this
 * process at its kill points and starts it again on the same data folder.
 *
 * Runtimes: "loop" (Studio's own loop on the Anthropic SDK), "hosts" (the
 * Claude sign-in's turn hosts, the Claude runtime pointed at the stand-in
 * API), "durable" (the durable harness, the bundled one in its own process).
 *
 * node daemon.mjs <config.json>
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { AgentRunner, type RunnerOptions } from "../../src/runner.js";
import { SessionStore } from "../../src/sessions.js";
import { AnthropicProvider } from "../../src/providers.js";
import { TurnHosts } from "../../src/hosted-turn.js";
import { syncOf } from "../../src/session-delta.js";
import { FakeHost } from "../durable/helpers.js";
import { routeSpec } from "../../src/durable/routes.js";

export interface DaemonConfig {
  runtime: "loop" | "hosts" | "durable";
  dataDir: string;
  projectDir: string;
  base: string;
  version: string;
  /** dist/ of the built agent: the harness, its extension and the turn host. */
  dist: string;
  callMs: number;
  ask: boolean;
  /** Run the durable runtime on the real Claude sign-in instead of the stand-in API: this model, through this Claude runtime. */
  claude?: { model: string; command: string };
}

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf-8")) as DaemonConfig;
const host = new FakeHost(config.projectDir, config.dataDir);
host.callMs = config.callMs;
const log = (m: string) => fs.appendFileSync(path.join(config.dataDir, "daemon.log"), `${new Date().toISOString()} [${process.pid}] ${m}\n`);
host.log = { info: (m: string) => log(m), warn: (m: string, e?: unknown) => log(`WARN ${m} ${e instanceof Error ? e.message : String(e ?? "")}`) };
const store = new SessionStore(config.dataDir);

const base: RunnerOptions = {
  host,
  store,
  model: () => "claude-sonnet-5-5",
  askBeforeChanges: () => config.ask,
  provider: () => new AnthropicProvider("test-key", new Anthropic({ apiKey: "test-key", baseURL: config.base })),
};
const runner = new AgentRunner(
  config.runtime === "durable" ? {
    ...base,
    ...(config.claude ? { model: () => config.claude!.model } : {}),
    durable: {
      route: () => (config.claude ? "claude" : "key:anthropic"),
      routeSpec: (model) => (config.claude
        // The route as Studio ships it, with the provider's own web search.
        ? routeSpec({ route: "claude", model, vendor: "anthropic", gatewayUrl: "", agentVersion: config.version, endpoint: () => null })
        : { route: "key:anthropic", provider: "anthropic", api: "anthropic-messages", model, baseUrl: config.base, auth: "apiKey" }),
      credential: async () => "test-key",
      harness: {
        dataDir: config.dataDir, projectDir: config.projectDir, version: config.version, script: path.join(config.dist, "durable-harness.js"), extensionFile: path.join(config.dist, "durable-extension.js"),
        ...(config.claude ? { claudeCommand: async () => config.claude!.command } : {}),
      },
    },
  } : config.runtime === "hosts" ? {
    ...base,
    subscription: () => true,
    turnHosts: new TurnHosts({ dataDir: config.dataDir, projectDir: config.projectDir, version: config.version, script: path.join(config.dist, "turn-host.js"), log: host.log }),
  } : base,
);
runner.recover();

const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const body = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {}));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(String(req.url), "http://x");
  try {
    if (url.pathname === "/session" && req.method === "POST") {
      const s = store.create("kill");
      return json(res, 200, { id: s.id });
    }
    if (url.pathname === "/send") {
      const b = await body(req);
      void runner.send(String(b.id), String(b.text)).catch((e) => log(`send failed: ${String(e)}`));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/detail") {
      const s = store.get(String(url.searchParams.get("id")));
      if (!s) return json(res, 404, {});
      return json(res, 200, syncOf(SessionStore.detail(s, (c) => runner.canMessage(s, c)), undefined, { tail: 500 }));
    }
    if (url.pathname === "/approve") {
      const b = await body(req);
      const s = store.get(String(b.id));
      const a = s?.approvals?.[0];
      return json(res, 200, { ok: !!a && runner.answerApproval(s!.id, a.id, "allow") });
    }
    if (url.pathname === "/message") {
      const b = await body(req);
      return json(res, 200, { ok: await runner.messageSubagent(String(b.id), String(b.callId), String(b.text)) });
    }
    if (url.pathname === "/dispose") {
      // A clean shutdown, as an update's restart does.
      runner.dispose();
      store.flush();
      json(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 50);
      return;
    }
    json(res, 404, {});
  } catch (e) {
    json(res, 500, { error: String(e) });
  }
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(path.join(config.dataDir, "daemon.json"), JSON.stringify({ pid: process.pid, port: (server.address() as AddressInfo).port }));
  log(`daemon up on ${config.runtime}`);
});
