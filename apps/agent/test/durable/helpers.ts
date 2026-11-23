/**
 * A fake daemon host and an AgentRunner on the durable runtime, for the
 * durable tests and the kill tests: no editor, no network beyond loopback.
 * Every editor call the host runs is appended to `calls.jsonl` in the data
 * folder, so a test can count across processes how often each call ran.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import { AgentRunner, type RunnerOptions } from "../../src/runner.js";
import { SessionStore } from "../../src/sessions.js";
import type { AgentHost } from "../../src/tools.js";
import type { HarnessLaunch } from "../../src/durable/protocol.js";

export class FakeHost implements AgentHost {
  connected = true;
  /** The extension features the daemon advertises. */
  features?: readonly string[];
  published: Array<{ type: string; data?: Record<string, unknown> }> = [];
  busy: () => boolean = () => false;
  private listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void> = [];
  /** How long an editor call takes, so a kill can land while one runs. */
  callMs = 0;
  log = { info: (m: string) => this.logged.push(m), warn: (m: string, e?: unknown) => this.logged.push(`WARN ${m} ${e instanceof Error ? e.message : e ?? ""}`) };
  logged: string[] = [];
  events = {
    publish: (type: string, data?: Record<string, unknown>) => {
      this.published.push({ type, data });
    },
    subscribe: (l: (e: { type: string; data: Record<string, unknown> }) => void) => {
      this.listeners.push(l);
      return () => {
        this.listeners = this.listeners.filter((x) => x !== l);
      };
    },
  };
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult> {
    if (category === "editor" && action === "list_dirty_packages") return { isError: false, content: [{ type: "text", text: "{\"success\":true,\"content\":[]}" }] };
    fs.appendFileSync(path.join(this.dataDir, "calls.jsonl"), `${JSON.stringify({ at: Date.now(), category, action, args, pid: process.pid })}\n`);
    if (this.callMs) await new Promise((r) => setTimeout(r, this.callMs));
    fs.appendFileSync(path.join(this.dataDir, "calls-ended.jsonl"), `${JSON.stringify({ at: Date.now(), category, action, pid: process.pid })}\n`);
    return { isError: false, content: [{ type: "text", text: `{"success":true,"did":"${category}.${action}"}` }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: this.connected, port: 1, pid: 1, lastDisconnect: null }];
  }
  async editorOperation(op: string) {
    return { op, steps: [{ step: `editor.${op}_editor`, ok: true }] };
  }
  setBusy(fn: () => boolean): void {
    this.busy = fn;
  }
  emit(type: string, data: Record<string, unknown> = {}): void {
    for (const l of this.listeners) l({ type, data });
  }
}

/** Every editor call the fake host ran in this data folder, from any process. */
export function editorCalls(dataDir: string): Array<{ category: string; action: string; args?: Record<string, unknown>; pid: number }> {
  try {
    return fs.readFileSync(path.join(dataDir, "calls.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export interface DurableRig {
  host: FakeHost;
  store: SessionStore;
  runner: AgentRunner;
}

/**
 * A runner whose route runs on the durable runtime against the fake Anthropic
 * API at `base`. `start` runs a harness (in-process for unit tests); `script`
 * the bundled one in a detached process.
 */
export function durableRunner(o: {
  projectDir: string;
  dataDir: string;
  base: string;
  start?: (launch: HarnessLaunch) => Promise<void> | void;
  script?: string | null;
  extra?: Partial<RunnerOptions>;
  /** The route has the provider's own web search, as an Anthropic key does. */
  search?: boolean;
  /** The extension features the fake daemon advertises. */
  features?: readonly string[];
}): DurableRig {
  const host = new FakeHost(o.projectDir, o.dataDir);
  if (o.features) host.features = o.features;
  const store = new SessionStore(o.dataDir);
  const runner = new AgentRunner({
    host,
    store,
    provider: () => {
      throw new Error("the durable runtime does not use Studio's providers");
    },
    model: () => "claude-opus-5-5",
    askBeforeChanges: () => false,
    ...o.extra,
    durable: {
      route: () => "key:anthropic",
      routeSpec: (model) => ({ route: "key:anthropic", provider: "anthropic", api: "anthropic-messages", model, baseUrl: o.base, auth: "apiKey", ...(o.search ? { search: true } : {}) }),
      credential: async () => "test-key",
      harness: { dataDir: o.dataDir, projectDir: o.projectDir, version: "0.0.0-test", script: o.script ?? null, extensionFile: null, ...(o.start ? { start: o.start } : {}) },
    },
  });
  return { host, store, runner };
}

export async function until(cond: () => boolean, ms = 20_000, what = "condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
