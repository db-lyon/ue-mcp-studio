/**
 * Studio on a ue-mcp older than it needs, for the visual QA harness: refused
 * by the daemon (health), refused by Studio itself (its refusal route), and
 * an update that failed.
 */
import type { Scenario } from "./fixtures";

const NEEDS = "1.4.11-beta.6";
const HAVE = "1.4.11-beta.4";

const health = {
  ok: true, pid: 1, version: HAVE, apiVersion: 1, projectRoot: "c:/projects/studioe2e", startedAt: new Date().toISOString(),
  editors: [{ name: "StudioE2E", connected: true, port: 1, pid: 1, lastDisconnect: null }],
  clients: 1, inflight: 0, lastEventId: 0, extensions: [], ui: "dev",
  refusedExtensions: [{ name: "studio", version: "0.1.24-beta.10", reason: `studio needs ue-mcp ${NEEDS} or later; this is ${HAVE}`, needsUeMcp: NEEDS }],
};

const refused = (title: string, o: Partial<Scenario> = {}): Scenario => ({ title, hash: "", index: { playtests: [], listed: true }, ...o });

export const REFUSED_SCENARIOS: Record<string, Scenario> = {
  "refused-by-daemon": refused("A ue-mcp that checks the floor refused Studio: one screen, one button", { get: (p) => (p === "/v1/health" ? health : undefined) }),
  "refused-by-studio": refused("An older ue-mcp loaded Studio, which answers only its refusal route", { get: (p) => (p === "/v1/ext/studio/refusal" ? { needs: NEEDS, have: HAVE } : undefined) }),
  "refused-update-failed": refused("Update ue-mcp pressed, and the install failed", {
    get: (p) => (p === "/v1/health" ? health : p === "/v1/update" ? { installed: { version: HAVE }, server: HAVE, latest: NEEDS, target: NEEDS, binaries: null } : undefined),
    post: (p) => (p === "/v1/update/apply" ? { status: 500, body: { ok: false, error: `no prebuilt bridge for UE 5.7 in ue-mcp ${NEEDS}` } } : undefined),
    click: ".refused button.primary",
  }),
};
