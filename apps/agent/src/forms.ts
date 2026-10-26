/**
 * Forms ue-mcp raises during a turn, such as approving a feedback report, put
 * to the user as cards in the chat the way an MCP client shows an elicitation
 * form. Under /v1/ext/studio:
 *
 *   GET  /forms        the forms waiting for an answer
 *   POST /forms/:id    answer one: { action: accept, content } or { action: decline | cancel }
 *
 * Changes arrive on the event stream as studio.form.changed.
 */
import * as crypto from "node:crypto";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import type { PendingForm } from "@ue-mcp-studio/shared";

export interface ElicitParams {
  message: string;
  requestedSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}
export type ElicitResult = { action: "accept"; content: Record<string, unknown> } | { action: "decline" | "cancel" };

export class FormBroker {
  private readonly waiting = new Map<string, { form: PendingForm; resolve: (r: ElicitResult) => void }>();

  constructor(private readonly publish: (type: string, data: Record<string, unknown>) => void, private readonly now = () => new Date().toISOString()) {}

  /** ue-mcp asks the user something during one of this session's calls; the call waits for the answer. */
  ask(sessionId: string, call: string, params: ElicitParams): Promise<ElicitResult> {
    const id = crypto.randomUUID();
    const form: PendingForm = {
      id, sessionId, call, at: this.now(),
      message: params.message,
      fields: params.requestedSchema.properties as PendingForm["fields"],
      required: params.requestedSchema.required ?? [],
    };
    return new Promise((resolve) => {
      this.waiting.set(id, { form, resolve });
      this.publish("form.changed", { sessionId });
    });
  }

  list(sessionId?: string): PendingForm[] {
    return [...this.waiting.values()].map((w) => w.form).filter((f) => !sessionId || f.sessionId === sessionId);
  }

  /** The user's answer. Returns an error when the form is gone or the answer is not one. */
  answer(id: string, body: unknown): string | null {
    const w = this.waiting.get(id);
    if (!w) return "that form is no longer waiting";
    const b = (body ?? {}) as { action?: unknown; content?: unknown };
    let result: ElicitResult;
    if (b.action === "decline" || b.action === "cancel") result = { action: b.action };
    else if (b.action === "accept" && b.content && typeof b.content === "object" && !Array.isArray(b.content)) {
      const content = b.content as Record<string, unknown>;
      const missing = w.form.required.filter((k) => content[k] === undefined || content[k] === "");
      if (missing.length) return `fill in ${missing.join(", ")}`;
      result = { action: "accept", content };
    } else return "body must be { action: accept, content } or { action: decline | cancel }";
    this.waiting.delete(id);
    w.resolve(result);
    this.publish("form.changed", { sessionId: w.form.sessionId });
    return null;
  }

  /** A stopped or deleted session's forms are cancelled, so their calls return. */
  cancelSession(sessionId: string): void {
    for (const [id, w] of this.waiting) {
      if (w.form.sessionId !== sessionId) continue;
      this.waiting.delete(id);
      w.resolve({ action: "cancel" });
    }
    this.publish("form.changed", { sessionId });
  }
}

export function registerForms(api: DaemonExtensionApi): FormBroker {
  const broker = new FormBroker((type, data) => api.events.publish(type, data));
  api.route("GET", "/forms", (req) => ({ body: { forms: broker.list(req.query?.session as string | undefined) } }));
  api.route("POST", "/forms/:id", (req) => {
    const error = broker.answer(req.params.id, req.body);
    return error ? { status: 409, body: { error } } : { status: 204 };
  });
  return broker;
}
