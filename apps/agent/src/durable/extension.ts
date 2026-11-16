/**
 * Studio's tools on the durable runtime, as one Pi Durable extension.
 *
 * Every tool the daemon defines (ue-mcp, the editor restart, shell, files,
 * web, skills, a subagent's reply) runs where it runs on every other route: in
 * the daemon, through its editor wait, its approval gate and its executor. The
 * harness asks the daemon for each call and waits for whichever daemon is
 * connected, so a daemon restart mid-wait costs nothing: the next one asks for
 * the approval again or waits for the editor again.
 *
 * Each call is replay-safe at the harness's level and never runs twice: once
 * a daemon says it is past the gate, that is recorded (memo "started") before
 * the daemon is told to go. A call whose run was told to go and never
 * answered has an unknown outcome, and the daemon reports it as one.
 *
 * The agent tool starts the subagent: the daemon gives it its slot and what it
 * runs with, and the harness runs its conversation (pi.ts runSubagent).
 *
 * This module is loaded again from a newer Studio's bundle when that Studio's
 * daemon connects, and installed over the running one (registry.install):
 * calls already running finish on the code they started with.
 */
import type { Kit } from "./pi.js";
import type { AgentStart, ToolDef } from "./protocol.js";
import type { ToolExecution } from "../tools.js";

/** This extension's version: a newer Studio's daemon installs its own over it. */
export const EXTENSION_NAME = "studio";

/** Studio's tool outputs are bounded by their own executors; the harness keeps all of what they return. */
const OUTPUT_LIMITS = { maxBytes: 2_000_000, maxLines: 100_000, retain: "head" as const };

const text = (t: string) => [{ type: "text" as const, text: t }];

export function createStudioExtension(kit: Kit, defs: ToolDef[]) {
  const tools = defs.map((d) => {
    if (d.name === "agent") {
      return kit.defineTool({
        name: d.name,
        description: d.description,
        parameters: d.input_schema as never,
        // A rerun after a crash finds the same subagent conversation and the same prompt submission.
        replay: "safe",
        outputLimits: OUTPUT_LIMITS,
        execute: async (args: Record<string, unknown>, api: { conversationId: unknown; callId: string }, context: { abortSignal?: AbortSignal }) => {
          const where = kit.whereIs(String(api.conversationId));
          if (!where || where.parent) return { output: text("A subagent cannot start subagents of its own."), isError: true };
          const start = (await kit.request({ kind: "agent", sessionId: where.sessionId, callId: api.callId, input: args }, undefined, context.abortSignal)) as AgentStart;
          if (!start.ok) return { output: text(start.text), isError: true };
          const r = await kit.runSubagent(where.sessionId, api.callId, start, context.abortSignal);
          return { output: text(r.text), isError: r.isError };
        },
      } as never);
    }
    return kit.defineTool({
      name: d.name,
      description: d.description,
      parameters: d.input_schema as never,
      replay: "safe",
      outputLimits: OUTPUT_LIMITS,
      execute: async (args: Record<string, unknown>, api: { conversationId: unknown; callId: string; memo(name: string, ...a: unknown[]): Promise<unknown> }, context: { abortSignal?: AbortSignal }) => {
        const where = kit.whereIs(String(api.conversationId));
        if (!where) return { output: text("This conversation belongs to no Studio session."), isError: true };
        const started = (await api.memo("started", context)) === true;
        const exec = (await kit.request(
          { kind: "tool", sessionId: where.sessionId, conv: String(api.conversationId), parent: where.parent, callId: api.callId, name: d.name, input: args, started },
          async () => {
            await api.memo("started", true, context);
          },
          context.abortSignal,
        )) as ToolExecution;
        const output: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = text(exec.modelText ?? exec.text);
        for (const img of exec.images ?? []) output.push({ type: "image", data: img.data, mimeType: img.mediaType });
        return { output, isError: exec.isError, details: { outcome: exec.outcome } };
      },
    } as never);
  });
  return kit.defineExtension({ name: EXTENSION_NAME, tools } as never);
}
