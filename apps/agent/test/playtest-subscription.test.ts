/**
 * /playtest on the Claude sign-in, with the Agent SDK replaced by a scripted
 * binary. The SDK cannot force a tool, so the turn allows pie alone: no
 * built-ins, no subagents, one tool on Studio's server. What the model writes
 * is not shown, and a turn without a saved script is the failure state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type?: string; text?: string }>; isError: boolean }>;
interface Binary {
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  emit(m: unknown): void;
}
interface Options {
  tools: unknown;
  allowedTools: string[];
  agents?: unknown;
  systemPrompt: string;
  mcpServers: { studio: { tools: Array<{ name: string; handler: Handler }> } };
}
const sdk = vi.hoisted(() => ({
  script: null as null | ((b: Binary) => Promise<void>),
  options: [] as Options[],
}));

vi.mock("../src/runtime.js", () => ({ ensureRuntime: async () => "claude.exe", installedRuntime: () => "claude.exe" }));
vi.mock("../src/claude-auth.js", async (actual) => {
  const login = { method: "claude.ai", subscription: "max", keySource: null };
  return { ...(await actual<typeof import("../src/claude-auth.js")>()), claudeLogin: () => login, refreshClaudeLogin: async () => login };
});
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: Handler) => ({ name, handler }),
  createSdkMcpServer: (o: { tools: Array<{ name: string; handler: Handler }> }) => ({ tools: o.tools }),
  query: ({ options }: { options: Options }) => {
    sdk.options.push(options);
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const binary: Binary = {
      async call(name, args) {
        const t = options.mcpServers.studio.tools.find((x) => x.name === name)!;
        const r = await t.handler(args);
        return { text: r.content.map((c) => c.text ?? "").join(""), isError: r.isError };
      },
      emit(m) {
        queue.push(m);
        wake?.();
      },
    };
    void sdk.script!(binary).finally(() => {
      done = true;
      wake?.();
    });
    return {
      async interrupt() {},
      stopTask: async () => {},
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            for (;;) {
              if (queue.length) return { value: queue.shift(), done: false };
              if (done) return { value: undefined, done: true };
              await new Promise<void>((r) => (wake = r));
              wake = null;
            }
          },
        };
      },
    };
  },
}));

const { AgentRunner } = await import("../src/runner.js");
const { SessionStore } = await import("../src/sessions.js");

let root: string;
let store: InstanceType<typeof SessionStore>;
let calls: Array<{ category: string; action: string }>;
let createAnswers: ActionResult[];
const env = { ...process.env };

const host = () => ({
  projectDir: path.join(root, "project"),
  dataDir: path.join(root, "data"),
  log: { info() {}, warn() {} },
  events: { publish: () => undefined, subscribe: () => () => {} },
  async callAction(category: string, action: string): Promise<ActionResult> {
    calls.push({ category, action });
    if (action === "script_create") return createAnswers.shift() ?? { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, path: "/Game/S/DoubleJump" }) }] };
    return { isError: false, content: [{ type: "text", text: "{\"success\":true}" }] };
  },
  editors: (): EditorStatus[] => [{ name: "P", connected: true, port: 1, pid: 1, lastDisconnect: null }],
  editorOperation: async (op: string) => ({ op, steps: [] }),
  setBusy() {},
});

const assistant = (id: string, content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content } });
const result = { type: "result", subtype: "success", is_error: false, session_id: "sdk-1" };
const STEPS = [{ instruction: "Press Space twice", judge: "manual" }];

async function pie(b: Binary, id: string) {
  const input = { action: "script_create", name: "DoubleJump", steps: STEPS };
  b.emit(assistant(`m_${id}`, [{ type: "tool_use", id, name: "mcp__studio__pie", input }]));
  const r = await b.call("pie", input);
  b.emit({ type: "user", parent_tool_use_id: null, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: r.text }], is_error: r.isError }] } });
  return r;
}

const runner = () => new AgentRunner({ host: host(), store, provider: () => { throw new Error("the API route is not used"); }, model: () => "claude-opus-5-5", subscription: () => true });
const kinds = (t: TranscriptEntry[]) => t.map((e) => (e.kind === "tool" ? `tool:${e.call.name}:${e.call.outcome}` : e.kind));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-playtest-sdk-"));
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  fs.mkdirSync(path.join(root, "project", "Content"), { recursive: true });
  store = new SessionStore(path.join(root, "data"));
  sdk.options = [];
  calls = [];
  createAnswers = [];
});

afterEach(() => {
  process.env = { ...env };
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a /playtest turn on the Claude sign-in", () => {
  it("allows only pie: no built-in tools, no subagents, one tool on Studio's server, and the playtest instruction", async () => {
    sdk.script = async (b) => {
      await pie(b, "p1");
      b.emit(assistant("m_end", [{ type: "text", text: "Done! Here are the steps:\n1. Jump - PASS" }]));
      b.emit(result);
    };
    const s = store.create();
    await runner().send(s.id, "/playtest");
    const o = sdk.options[0];
    expect(o.tools).toEqual([]);
    expect(o.allowedTools).toEqual(["mcp__studio__pie"]);
    expect(o.agents).toBeUndefined();
    expect(o.mcpServers.studio.tools.map((t) => t.name)).toEqual(["pie"]);
    expect(o.systemPrompt).toMatch(/This turn is a \/playtest/);
    expect(calls.filter((c) => c.category === "pie")).toEqual([{ category: "pie", action: "script_create" }]);
    const fin = store.get(s.id)!;
    // The model's closing prose is not in the transcript.
    expect(kinds(fin.transcript)).toEqual(["user", "tool:pie:done"]);
    expect(fin.status).toBe("idle");
  });

  it("an ordinary turn keeps its tools", async () => {
    sdk.script = async (b) => {
      b.emit(assistant("m", [{ type: "text", text: "hi" }]));
      b.emit(result);
    };
    const s = store.create();
    await runner().send(s.id, "hello");
    expect(sdk.options[0].tools).toEqual(["Agent", "WebSearch"]);
    expect(sdk.options[0].mcpServers.studio.tools.map((t) => t.name)).not.toContain("pie");
  });

  it("a turn that ends without a saved script shows No playtest was made, not what the model wrote", async () => {
    sdk.script = async (b) => {
      b.emit(assistant("m", [{ type: "text", text: "1. Jump - PASS\n2. Land - PASS" }]));
      b.emit(result);
    };
    const s = store.create();
    await runner().send(s.id, "/playtest the jump");
    const fin = store.get(s.id)!;
    expect(kinds(fin.transcript)).toEqual(["user", "playtest-failed"]);
    expect(fin.transcript[1]).toMatchObject({ request: { text: "the jump" } });
    expect(fin.status).toBe("idle");
  });

  it("answers a validation error once, refuses a third call, and fails with the error", async () => {
    const bad = { isError: false, content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: "steps[0].judge must be auto or manual" }) }] };
    createAnswers = [bad, bad];
    const seen: string[] = [];
    sdk.script = async (b) => {
      seen.push((await pie(b, "p1")).text, (await pie(b, "p2")).text, (await pie(b, "p3")).text);
      b.emit(result);
    };
    const s = store.create();
    await runner().send(s.id, "/playtest");
    expect(seen[0]).toMatch(/call pie with action script_create once more/);
    expect(seen[1]).toMatch(/That was the last attempt/);
    expect(seen[2]).toMatch(/has had its attempts/);
    expect(calls.filter((c) => c.action === "script_create")).toHaveLength(2);
    const fin = store.get(s.id)!;
    expect(kinds(fin.transcript).at(-1)).toBe("playtest-failed");
    expect((fin.transcript.at(-1) as { reason: string }).reason).toMatch(/judge must be auto or manual/);
  });
});
