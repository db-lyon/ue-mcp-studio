/**
 * A stand-in for the Anthropic Messages API that streams scripted turns, for
 * the durable runtime's tests and the kill tests. Each request's turn is
 * picked by how many tool results the conversation already holds, so a
 * request sent again after a restart gets the same answer. Every request is
 * counted, in memory and, when `log` is given, as a line in that file, so a
 * test in another process can count requests across kills.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeTurn {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
  /** Pause between streamed events, so a kill can land mid-stream. */
  paceMs?: number;
  /** Pause before the answer starts. */
  delayMs?: number;
  /** The input tokens the answer reports, to fill the context as a long conversation would. */
  inputTokens?: number;
  /** Thinking streamed before the answer. */
  thinking?: string;
  /** Refuse the request with this HTTP status (a 400 is not retried) and `error` as its message. */
  status?: number;
  error?: string;
}

export interface FakeAnthropic {
  base: string;
  /** `serverTools`: the types of the tools that run on the provider's side, such as its web search. */
  /** `userText`: the request's messages as JSON; `inputTokens`: the input tokens its answer reported. */
  requests: Array<{ model: string; tools: string[]; serverTools: string[]; toolResults: number; system: string; userText: string; inputTokens?: number }>;
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

export async function startFakeAnthropic(script: (req: { toolResults: number; system: string; userText: string }) => FakeTurn, log?: string): Promise<FakeAnthropic> {
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
    const userText = JSON.stringify(body.messages ?? []);
    const tools = ((body.tools ?? []) as Array<{ name: string }>).map((t) => t.name);
    // A runtime's own side requests (a title, a quota check) carry none of Studio's tools: answered, not counted.
    const studio = tools.some((t) => /(^|__)ue_mcp$/.test(t));
    const serverTools = ((body.tools ?? []) as Array<{ type?: string }>).map((t) => t.type ?? "").filter((t) => t && t !== "custom");
    requests.push({ model: String(body.model), tools, serverTools, toolResults: n, system, userText });
    if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), toolResults: n, studio, sub: system.includes("You are a subagent") })}\n`);
    const turn: FakeTurn = studio ? script({ toolResults: n, system, userText }) : { text: "ok" };
    // On the Claude runtime Studio's tools are MCP tools of the server "studio".
    if (turn.tool && !tools.includes(turn.tool.name)) {
      const named = tools.find((t) => t.endsWith(`__${turn.tool!.name}`));
      if (named) turn.tool = { ...turn.tool, name: named };
    }
    if (turn.status) {
      res.writeHead(turn.status, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: turn.error ?? "refused" } }));
      return;
    }
    const pace = turn.paceMs ?? 5;
    if (turn.delayMs) await new Promise((r) => setTimeout(r, turn.delayMs));
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = async (data: Record<string, unknown>) => {
      if (res.destroyed) return;
      res.write(`event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`);
      await new Promise((r) => setTimeout(r, pace));
    };
    const id = ++seq;
    const usage = { input_tokens: turn.inputTokens ?? 100 + n, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    requests[requests.length - 1].inputTokens = usage.input_tokens;
    await send({ type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } });
    let index = 0;
    if (turn.thinking) {
      await send({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const part of turn.thinking.match(/.{1,12}/gs) ?? []) await send({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } });
      await send({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } });
      await send({ type: "content_block_stop", index });
      index++;
    }
    if (turn.text) {
      await send({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const part of turn.text.match(/.{1,12}/gs) ?? []) await send({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
      await send({ type: "content_block_stop", index });
      index++;
    }
    if (turn.tool) {
      await send({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${n}_${turn.tool.name}`, name: turn.tool.name, input: {} } });
      await send({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.tool.input) } });
      await send({ type: "content_block_stop", index });
    }
    await send({ type: "message_delta", delta: { stop_reason: turn.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
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
