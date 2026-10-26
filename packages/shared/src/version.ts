/**
 * Versions, and the refusal Studio answers with on a ue-mcp below its floor
 * (package.json ueMcpExtension.ueMcp).
 */

/** 0.1.0-beta.10 is newer than 0.1.0-beta.9: numbers compare as numbers, a release beats its prereleases. */
export function isNewer(a: string, b: string): boolean {
  const split = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { core: core.split(".").map(Number), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) > (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return !x.pre.length && y.pre.length > 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) > Number(q);
    if (pn !== qn) return !pn;
    if (p !== q) return p > q;
  }
  return false;
}

/** GET /v1/ext/studio/refusal, the only route Studio registers on a ue-mcp below its floor. */
export interface StudioRefusal {
  /** The oldest ue-mcp Studio runs on. */
  needs: string;
  /** The ue-mcp the daemon runs. */
  have: string;
}

/** An entry of /v1/health refusedExtensions, from a ue-mcp that checks the floor itself. */
export interface RefusedExtension {
  name: string;
  version: string;
  reason: string;
  needsUeMcp?: string;
}

/** Studio's refusal in a health answer, or null when the daemon loaded it. */
export function refusalInHealth(h: { version: string; refusedExtensions?: RefusedExtension[] } | null | undefined): StudioRefusal | null {
  const r = h?.refusedExtensions?.find((e) => e.name === "studio" && e.needsUeMcp);
  return r?.needsUeMcp ? { needs: r.needsUeMcp, have: h!.version } : null;
}
