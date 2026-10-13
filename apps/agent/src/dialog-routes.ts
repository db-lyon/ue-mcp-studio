/**
 * Editor dialogs, under /v1/ext/studio:
 *
 *   GET  /dialogs        the dialogs open now, and whether the daemon puts Studio's calls' dialogs to Studio
 *   POST /dialogs/:id    answer one: { answer: press, button, items? }, { answer: delegate } or { answer: release }
 *
 * Changes arrive on the event stream as studio.dialog.changed, carrying the
 * same state and the session the dialog belongs to.
 */
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import type { DialogAnswer } from "@ue-mcp-studio/shared";
import { DialogBroker, type DialogHost } from "./dialogs.js";
import type { SessionStore } from "./sessions.js";
import type { SettingsStore } from "./settings.js";
import type { FormBroker } from "./forms.js";

/** A request body as a DialogAnswer, or null when it is not one. */
export function dialogAnswerOf(body: unknown): DialogAnswer | null {
  const b = (body ?? {}) as { answer?: unknown; button?: unknown; items?: unknown };
  if (b.answer === "delegate" || b.answer === "release") return { answer: b.answer };
  if (b.answer !== "press" || typeof b.button !== "string" || !b.button) return null;
  if (b.items === undefined) return { answer: "press", button: b.button };
  if (!Array.isArray(b.items) || !b.items.every((i) => i && Number.isInteger(i.index) && typeof i.checked === "boolean")) return null;
  return { answer: "press", button: b.button, items: (b.items as Array<{ index: number; checked: boolean }>).map(({ index, checked }) => ({ index, checked })) };
}

export function registerDialogs(api: DaemonExtensionApi, store: SessionStore, settings: SettingsStore, forms?: FormBroker): DialogBroker {
  const broker = new DialogBroker({ host: api as unknown as DialogHost, store, policy: () => settings.dialogPolicy(), forms });
  api.route("GET", "/dialogs", () => ({ body: broker.state() }));
  api.route("POST", "/dialogs/:id", async (req) => {
    const answer = dialogAnswerOf(req.body);
    if (!answer) return { status: 400, body: { error: "body must be { answer: press, button, items? }, { answer: delegate } or { answer: release }" } };
    const error = await broker.answer(req.params.id, answer);
    return error ? { status: 409, body: { error } } : { status: 204 };
  });
  return broker;
}
