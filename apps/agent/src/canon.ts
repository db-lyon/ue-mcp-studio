/**
 * How a call to one of ue-mcp's projected category tools reads as the ue_mcp
 * call it is. Pure data in, data out, so a turn host process can rebuild it
 * from the projected tools it is handed without the rest of the surface.
 */

/** A projected tool as far as reading its calls back needs: its parameters and its category. */
export interface CanonTool {
  name: string;
  inputSchema: Record<string, unknown>;
  /** The category this tool is; null or absent for one that is not. */
  category?: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * A category tool's call read as ue_mcp's: `action` names the method; the
 * parameters are `args` when every other key is one the tool advertises
 * (routing such as an editor target, merged in), else the call is flat.
 */
export function canonCategoryCall(tool: CanonTool, input: Record<string, unknown>): Record<string, unknown> {
  const { action, args, ...rest } = input;
  const advertised = new Set(Object.keys((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {}));
  const envelope = isObj(args) && Object.keys(rest).every((k) => advertised.has(k));
  const params = envelope ? { ...(args as Record<string, unknown>), ...rest } : { ...rest, ...(args !== undefined ? { args } : {}) };
  return { action: "call", category: tool.category, method: typeof action === "string" ? action : "", args: params };
}

/** A projected category call as the ue_mcp call it is; any other call unchanged. */
export function canonFor(tools: readonly CanonTool[]): (name: string, input: Record<string, unknown>) => { name: string; input: Record<string, unknown> } {
  const byName = new Map(tools.map((t) => [t.name, t]));
  return (name, input) => {
    const t = byName.get(name);
    return t?.category ? { name: "ue_mcp", input: canonCategoryCall(t, input) } : { name, input };
  };
}
