/**
 * The Agent SDK replaced by a scripted binary, and the daemon host the runner
 * runs against, for the tests of the Claude sign-in route. A test file mocks
 * the SDK with it:
 *
 *   vi.mock("@anthropic-ai/claude-agent-sdk", async () => (await import("./fake-sdk.js")).fakeSdk);
 *
 * The binary sends messages, calls Studio's tools through the in-process
 * server, and keeps going after an abort the way the real one does on Windows
 * until it is killed.
 */
import type { ActionResult, EditorStatus } from "ue-mcp/daemon";

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>; isError: boolean }>;
export interface FakeBinary {
  /** Call one of Studio's tools the way the binary does, by its SDK name. */
  call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; content?: Array<{ type?: string; mimeType?: string }> }>;
  emit(m: unknown): void;
  end(): void;
  signal: AbortSignal;
  prompt: unknown;
  /** What the user said while the turn ran, streamed into the binary's input after the first message. */
  said: unknown[];
  /** Fire one hook event the way the binary does, with the matchers' tool filter: each callback's answer. */
  hook(event: string, input: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  /** The options this conversation was started with: a subagent's system prompt says it is one. */
  options: Record<string, unknown>;
  /** Studio's tools this conversation was given, by their names on the in-process server. */
  tools: string[];
  /** The conversation's first message as text, once the binary has read it from its input. */
  first: () => Promise<string>;
}

export const sdk = {
  script: null as null | ((b: FakeBinary) => Promise<void>),
  prompts: [] as unknown[],
  envs: [] as Array<Record<string, string | undefined>>,
  resumes: [] as Array<string | undefined>,
  interrupts: 0,
  backgrounded: 0,
  stopTask: null as null | ((taskId: string) => void),
  options: [] as Array<Record<string, unknown>>,
};

export const fakeSdk = {
  tool: (name: string, description: string, _s: unknown, handler: Handler, extras?: { annotations?: Record<string, unknown> }) => ({ name, description, handler, annotations: extras?.annotations }),
  createSdkMcpServer: (o: { tools: Array<{ name: string; handler: Handler }> }) => ({ tools: o.tools }),
  query: ({ prompt, options }: { prompt: unknown; options: { resume?: string; mcpServers: { studio: { tools: Array<{ name: string; handler: Handler }> } }; abortController: AbortController; env: Record<string, string | undefined> } }) => {
    // A streamed input: its first message is the prompt, as text when it is only text; later ones are what the user said mid-turn.
    const slot = sdk.prompts.length;
    sdk.prompts.push(prompt);
    const said: unknown[] = [];
    let gotFirst!: (text: string) => void;
    const firstText = new Promise<string>((r) => (gotFirst = r));
    if (prompt && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
      void (async () => {
        let first = true;
        for await (const m of prompt as AsyncIterable<{ message: { content: Array<{ type: string; text?: string }> } }>) {
          const c = m.message.content;
          const value = c.every((b) => b.type === "text") ? c.map((b) => b.text).join("\n\n") : m;
          if (first) {
            sdk.prompts[slot] = value;
            gotFirst(c.filter((b) => b.type === "text").map((b) => b.text).join("\n\n"));
          } else said.push(value);
          first = false;
        }
      })();
    } else gotFirst(String(prompt));
    sdk.options.push(options as unknown as Record<string, unknown>);
    sdk.envs.push(options.env);
    sdk.resumes.push(options.resume);
    const queue: unknown[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    const push = (m: unknown) => {
      queue.push(m);
      wake?.();
    };
    const binary: FakeBinary = {
      async call(name, args) {
        const t = options.mcpServers.studio.tools.find((x) => x.name === name)!;
        // The binary cannot reach the in-process server once its input is closed.
        if (options.abortController.signal.aborted) return { text: "The tool call was interrupted before a result was received.", isError: true };
        const r = await t.handler(args);
        return { text: r.content.map((c) => c.text ?? "").join(""), isError: r.isError, content: r.content };
      },
      emit: push,
      end() {
        done = true;
        wake?.();
      },
      signal: options.abortController.signal,
      prompt,
      said,
      options: options as unknown as Record<string, unknown>,
      tools: options.mcpServers.studio.tools.map((t) => t.name),
      first: () => firstText,
      async hook(event, input) {
        type Matcher = { matcher?: string; hooks: Array<(i: unknown, id: string | undefined, o: { signal: AbortSignal }) => Promise<Record<string, unknown>>> };
        const matchers = ((options as { hooks?: Record<string, Matcher[]> }).hooks ?? {})[event] ?? [];
        const out: Array<Record<string, unknown>> = [];
        for (const m of matchers) {
          if (m.matcher && m.matcher !== input.tool_name) continue;
          for (const h of m.hooks) out.push(await h({ hook_event_name: event, ...input }, input.tool_use_id as string | undefined, { signal: new AbortController().signal }));
        }
        return out;
      },
    };
    void sdk.script!(binary).finally(() => binary.end());
    return {
      async interrupt() {
        sdk.interrupts++;
      },
      async backgroundTasks() {
        sdk.backgrounded++;
        return true;
      },
      stopTask: async (taskId: string) => sdk.stopTask?.(taskId),
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
};

/** The daemon as the runner sees it: one editor, actions that succeed, events a test can raise. */
export class Host {
  connected = true;
  private listeners: Array<(e: { type: string; data: Record<string, unknown> }) => void> = [];
  log = { info() {}, warn() {} };
  events = {
    publish: () => undefined,
    subscribe: (l: (e: { type: string; data: Record<string, unknown> }) => void) => {
      this.listeners.push(l);
      return () => void (this.listeners = this.listeners.filter((x) => x !== l));
    },
  };
  operation: (op: string) => Promise<Record<string, unknown>> = async (op) => ({ op, steps: [] });
  constructor(public projectDir: string, public dataDir: string) {}
  async callAction(category: string, action: string): Promise<ActionResult> {
    return { isError: false, content: [{ type: "text", text: JSON.stringify({ success: true, category, action }) }] };
  }
  editors(): EditorStatus[] {
    return [{ name: "P", connected: this.connected, port: 1, pid: 1, lastDisconnect: null }];
  }
  editorOperation(op: "start" | "stop" | "restart" | "rebuild") {
    return this.operation(op);
  }
  setBusy(): void {}
  emit(type: string, data: Record<string, unknown> = {}): void {
    for (const l of this.listeners) l({ type, data });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met");
    await sleep(5);
  }
}

export const assistant = (id: string, content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content } });
export const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name: `mcp__studio__${name}`, input });
export const results = (id: string, r: { text: string; isError: boolean }) => ({
  type: "user",
  parent_tool_use_id: null,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text: r.text }], is_error: r.isError }] },
});

/** One tool call the way the binary makes it: the block, the call, the result. */
export async function use(b: FakeBinary, id: string, name: string, input: Record<string, unknown>) {
  b.emit(assistant(`m_${id}`, [toolUse(id, name, input)]));
  const r = await b.call(name, input);
  b.emit(results(id, r));
  return r;
}
