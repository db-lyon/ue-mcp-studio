/**
 * The catalog /action completes from, and the parameters its form is built
 * from, both read from ue-mcp through the daemon's extension API: the action
 * list and each action's effect from actions.effects, the one-line
 * descriptions and parameter schemas from project(describe_action), which
 * reads the tool graph in the server process and answers with no editor.
 */
import type { ActionResult } from "ue-mcp/daemon";
import type { ActionDescription, ActionListing } from "@ue-mcp-studio/shared";
import { summary } from "./discovery.js";

export interface ActionEffectRow {
  category: string;
  action: string;
  effect: string;
  destructive?: boolean;
}

export interface CatalogSource {
  effects(): ActionEffectRow[];
  callAction(category: string, action: string, args?: Record<string, unknown>): Promise<ActionResult>;
}

function body(r: ActionResult): Record<string, unknown> | null {
  const text = r.content.map((c) => c.text ?? "").join("");
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why a describe_action call failed, in its own words. */
function failure(r: ActionResult): string {
  const b = body(r);
  if (b && typeof b.error === "string") return b.error;
  return r.content.map((c) => c.text ?? "").join("\n").trim() || "describe_action failed";
}

/**
 * The catalog, built once per set of actions: a plugin that adds or removes
 * actions changes the set, and the next read builds it again.
 */
export class ActionCatalog {
  private built: { key: string; listing: Promise<ActionListing[]> } | null = null;

  constructor(private readonly source: CatalogSource) {}

  list(): Promise<ActionListing[]> {
    const rows = this.source.effects();
    const key = rows.map((r) => `${r.category}.${r.action}`).join(",");
    if (this.built?.key !== key) this.built = { key, listing: this.build(rows) };
    return this.built.listing;
  }

  invalidate(): void {
    this.built = null;
  }

  private async build(rows: ActionEffectRow[]): Promise<ActionListing[]> {
    const categories = [...new Set(rows.map((r) => r.category))];
    // A category describe_action cannot read still lists its actions, without their lines.
    const lines = new Map<string, string>();
    await Promise.all(categories.map(async (category) => {
      const r = await this.source.callAction("project", "describe_action", { category }).catch(() => null);
      const actions = r && !r.isError ? body(r)?.actions : null;
      if (!Array.isArray(actions)) return;
      for (const a of actions as Array<{ tool?: unknown; action?: unknown; description?: unknown }>) {
        if (typeof a.action === "string" && typeof a.description === "string") lines.set(`${category}.${a.action}`, summary(a.description, 120));
      }
    }));
    return rows.map((r) => {
      const name = `${r.category}.${r.action}`;
      const line = lines.get(name);
      return { name, category: r.category, method: r.action, ...(line ? { summary: line } : {}), effect: r.effect, ...(r.destructive ? { destructive: true } : {}) };
    });
  }

  /** One action's parameters. Throws with ue-mcp's answer for a name it does not know. */
  async describe(category: string, method: string): Promise<ActionDescription> {
    const r = await this.source.callAction("project", "describe_action", { name: `${category}.${method}` });
    if (r.isError) throw new Error(failure(r));
    const b = body(r);
    if (!b || typeof b.tool !== "string" || typeof b.action !== "string" || !Array.isArray(b.params)) throw new Error(failure(r));
    return b as unknown as ActionDescription;
  }
}
