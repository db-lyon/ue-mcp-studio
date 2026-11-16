/**
 * A stand-in for the Anthropic Messages API that streams scripted turns, for
 * the durable runtime's tests and the kill tests. Each request's turn is
 * picked by how many tool results the conversation already holds, so a
 * request sent again after a restart gets the same answer. Every request is
 * counted, in memory and, when `log` is given, as a line in that file, so a
 * test in another process can count requests across kills.
 *
 * A script may also answer asynchronously (to hold a turn until the test lets
 * it go), with several tool calls under ids of its own, and with the usage it
 * reports. Each request is kept whole (its messages and body) for the tests
 * that read what the model was sent.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The tool_use id; toolu_<results>_<name> when not given. */
  id?: string;
}

export interface FakeTurn {
  text?: string;
  tool?: FakeToolCall;
  /** Several tool calls in one answer, after `tool` when both are given. */
  tools?: FakeToolCall[];
  /** Pause between streamed events, so a kill can land mid-stream. */
  paceMs?: number;
  /** Pause before the answer starts. */
  delayMs?: number;
  /** The tokens the answer reports; 100 + tool results in and 20 out when not given. */
  usage?: { input: number; output: number };
  /** The input tokens the answer reports, to fill the context as a long conversation would. */
  inputTokens?: number;
  /** Answer with this HTTP error instead, as an overloaded or failing provider does. */
  status?: number;
}

/** One request as the model got it. */
export interface FakeRequest {
  model: string;
  tools: string[];
  /** The types of the tools that run on the provider's side, such as its web search. */
  serverTools: string[];
  toolResults: number;
  system: string;
  /** A subagent's request: its system prompt says so. */
  sub: boolean;
  messages: Array<{ role: string; content: unknown }>;
  body: Record<string, unknown>;
}

/** What a script is handed for each request. `signal` aborts when the client drops the request. */
export interface FakeScriptRequest extends FakeRequest {
  userText: string;
  signal: AbortSignal;
}

export interface FakeAnthropic {
  base: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const readJson = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    try {
      resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}") as Record<string, unknown>);
    } catch {
      resolve({});
    }
  });
});

/** How many tool results a request's conversation holds: which turn of the script it is. */
function toolResults(body: Record<string, unknown>): number {
  let n = 0;
  for (const m of (body.messages ?? []) as Array<{ content?: unknown }>) {
    if (Array.isArray(m.content)) n += (m.content as Array<{ type?: string }>).filter((b) => b.type === "tool_result").length;
  }
  return n;
}

export async function startFakeAnthropic(script: (req: FakeScriptRequest) => FakeTurn | Promise<FakeTurn>, log?: string): Promise<FakeAnthropic> {
  const requests: FakeAnthropic["requests"] = [];
  let seq = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !new URL(String(req.url), "http://x").pathname.endsWith("/v1/messages")) {
      res.writeHead(404).end();
      return;
    }
    const body = await readJson(req);
    const n = toolResults(body);
    const system = Array.isArray(body.system) ? (body.system as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n") : String(body.system ?? "");
    const messages = (body.messages ?? []) as FakeRequest["messages"];
    const userText = JSON.stringify(messages);
    const tools = ((body.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
    // A runtime's own side requests (a title, a quota check) carry none of Studio's tools: answered, not counted.
    const studio = tools.some((t) => /(^|__)(ue_mcp|shell|reply)$/.test(t));
    const serverTools = ((body.tools ?? []) as Array<{ type?: string }>).map((t) => t.type ?? "").filter((t) => t && t !== "custom");
    const sub = system.includes("You are a subagent");
    const request: FakeRequest = { model: String(body.model), tools, serverTools, toolResults: n, system, sub, messages, body };
    requests.push(request);
    if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), toolResults: n, studio, sub })}\n`);
    const dropped = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) dropped.abort();
    });
    let turn: FakeTurn;
    try {
      turn = studio ? await script({ ...request, userText, signal: dropped.signal }) : { text: "ok" };
    } catch {
      if (!res.destroyed) res.destroy();
      return;
    }
    if (dropped.signal.aborted) return;
    if (turn.status) {
      res.writeHead(turn.status, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ type: "error", error: { type: turn.status === 529 ? "overloaded_error" : "api_error", message: "busy" } }));
      return;
    }
    // On the Claude runtime Studio's tools are MCP tools of the server "studio".
    const named = (t: FakeToolCall): FakeToolCall => {
      if (tools.includes(t.name)) return t;
      const full = tools.find((x) => x.endsWith(`__${t.name}`));
      return full ? { ...t, name: full } : t;
    };
    const calls = [...(turn.tool ? [turn.tool] : []), ...(turn.tools ?? [])].map(named);
    const pace = turn.paceMs ?? 5;
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = async (data: Record<string, unknown>) => {
      if (res.destroyed) return;
      res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
      await new Promise((r) => setTimeout(r, pace));
    };
    const id = ++seq;
    const usage = { input_tokens: turn.usage?.input ?? turn.inputTokens ?? 100 + n, output_tokens: turn.usage ? 0 : 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    await send({ type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    let index = 0;
    if (turn.text) {
      await send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const part of turn.text.match(/.{1,12}/gs) ?? []) await send({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
      await send({ type: "content_block_stop", index });
      index++;
    }
    for (const call of calls) {
      await send({ type: "content_block_start", index, content_block: { type: "tool_use", id: call.id ?? `toolu_${n}_${call.name}`, name: call.name, input: {} } });
      await send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } });
      await send({ type: "content_block_stop", index });
      index++;
    }
    await send({ type: "message_delta", delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: turn.usage?.output ?? 20 } });
    await send({ type: "message_stop" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
