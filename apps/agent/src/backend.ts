/**
 * ue-mcp's extension API types the members a daemon gained over time as
 * optional. Studio refuses to run below its ue-mcp floor, so every member it
 * uses is there; this reads one as present, and fails loudly if it is not.
 */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`ue-mcp has no ${what}; Studio needs a newer ue-mcp`);
  return value;
}
