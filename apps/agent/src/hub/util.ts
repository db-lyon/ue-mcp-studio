/**
 * Small pieces every part of the Playtest Hub uses: the error a route turns
 * into its status, and reading ue-mcp's answers.
 */
import type { ActionResult } from "ue-mcp/daemon";
import { parseCheckId, type CheckKind, type CheckRef } from "@ue-mcp-studio/shared";

/** A refusal with the HTTP status its route answers: 400 a bad body, 404 nothing by that id, 409 not now. */
export class HubError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export const bad = (message: string): HubError => new HubError(400, message);
export const notFound = (message: string): HubError => new HubError(404, message);
export const conflict = (message: string): HubError => new HubError(409, message);

const text = (r: ActionResult): string => r.content.map((c) => c.text ?? "").join("\n");

/** An answer's JSON body, or null when the call failed or said success: false. */
export function answerOf(r: ActionResult | null): Record<string, unknown> | null {
  if (!r || r.isError) return null;
  try {
    const v = JSON.parse(text(r)) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return (v as Record<string, unknown>).success === false ? null : (v as Record<string, unknown>);
  } catch {
    return null;
  }
}

/** Why a call failed, or null when it worked. */
export function failureOf(r: ActionResult): string | null {
  if (r.isError) return text(r) || "the call failed";
  try {
    const v = JSON.parse(text(r)) as Record<string, unknown> | null;
    if (v && v.success === false) return typeof v.error === "string" ? v.error : "the call failed";
  } catch {
    // Not JSON: not a refusal either.
  }
  return null;
}

const KINDS: readonly CheckKind[] = ["script", "uat", "repro", "automation", "manual"];

/** A check reference from a body or a goal file, normalized; null when it is not one. */
export function checkRefOf(v: unknown): CheckRef | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!KINDS.includes(o.kind as CheckKind) || typeof o.target !== "string" || !o.target.trim()) return null;
  const kind = o.kind as CheckKind;
  let target = o.target.trim();
  // A script is its asset path without the object name, however it was written.
  if (kind === "script") {
    if (!target.startsWith("/")) return null;
    const dot = target.lastIndexOf(".");
    if (dot > target.lastIndexOf("/")) target = target.slice(0, dot);
  }
  return {
    kind,
    target,
    ...(typeof o.title === "string" && o.title.trim() ? { title: o.title.trim() } : {}),
    ...(o.required === false ? { required: false } : {}),
  };
}

/** A check id from a path parameter, already decoded by the daemon; null when it names no check. */
export function checkOfId(id: string): CheckRef | null {
  const p = parseCheckId(id);
  return p ? checkRefOf(p) : null;
}

export const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
