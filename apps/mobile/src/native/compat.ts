/**
 * Whether the Studio on the paired computer is new enough for this app: the
 * app calls routes and reads answers Studio added over time, and an older
 * Studio would leave parts blank or refuse them. Read from the daemon's health
 * (its extensions list carries Studio's version).
 */
import Constants from "expo-constants";

/** The oldest Studio whose routes and answers this app relies on (the context meter and compaction markers). */
export const MIN_STUDIO = "0.1.25-beta.30";

export const APP_VERSION: string = Constants.expoConfig?.version ?? "0.0.0";

/** Semver order, prereleases before their release ("0.1.25-beta.9" < "0.1.25-beta.30" < "0.1.25"). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    return { core: core.split(".").map((n) => Number(n) || 0), pre: pre ? pre.split(".") : [] };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return x.pre.length ? -1 : y.pre.length ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = Number(p);
    const qn = Number(q);
    if (!Number.isNaN(pn) && !Number.isNaN(qn)) {
      if (pn !== qn) return pn - qn;
    } else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export interface Versions {
  ueMcp: string | null;
  studio: string | null;
}

/** ue-mcp's and Studio's versions from GET /v1/health. */
export function versionsOf(health: { version?: unknown; extensions?: unknown } | null | undefined): Versions {
  const ext = Array.isArray(health?.extensions) ? (health!.extensions as Array<{ name?: unknown; version?: unknown }>) : [];
  const studio = ext.find((e) => e.name === "studio");
  return { ueMcp: typeof health?.version === "string" ? health.version : null, studio: typeof studio?.version === "string" ? studio.version : null };
}

/** Null when Studio is new enough or its version is unknown ("dev" builds included); otherwise what to tell the owner. */
export function studioTooOld(studio: string | null): string | null {
  if (!studio || !/^\d+\.\d+\.\d+/.test(studio)) return null;
  if (compareVersions(studio, MIN_STUDIO) >= 0) return null;
  return `Studio on this computer is ${studio}; this app needs ${MIN_STUDIO} or newer. Update Studio on the computer, then come back.`;
}
