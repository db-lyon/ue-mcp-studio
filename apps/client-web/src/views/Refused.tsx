/**
 * Studio on a ue-mcp older than it needs: one screen, one button. The daemon
 * names the refusal in /v1/health (refusedExtensions) when it checks the
 * floor itself; an older daemon loads Studio, which then answers only
 * /v1/ext/studio/refusal. The button installs ue-mcp through the target
 * release's own CLI (updateUeMcp).
 */
import { useEffect, useState } from "react";
import { isNewer, refusalInHealth, type RefusedExtension, type StudioRefusal } from "@ue-mcp-studio/shared";
import { native, type StudioBinding } from "../native";

/** Studio's refusal, null when Studio runs, undefined until the agent has answered. */
export function useRefusal(health: { version: string; refusedExtensions?: RefusedExtension[] } | null): StudioRefusal | null | undefined {
  const [own, setOwn] = useState<StudioRefusal | null | undefined>(undefined);
  useEffect(() => {
    fetch("/v1/ext/studio/refusal", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<StudioRefusal>) : null))
      .then(setOwn, () => setOwn(null));
  }, []);
  return refusalInHealth(health) ?? own;
}

interface Check {
  latest: string | null;
}
interface Applied {
  ok: boolean;
  version: string;
  error?: string;
}

/** How long the window's run of the target CLI may take, npx download included. */
export const WINDOW_UPDATE_MS = 15 * 60_000;
const POLL_MS = 1000;

const post = (send: typeof fetch, url: string, body: unknown) =>
  send(url, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .catch((e: Error) => new Response(JSON.stringify({ error: e.message }), { status: 500 }));

async function answered(res: Response, version: string): Promise<Applied> {
  const r = (await res.json().catch(() => ({}))) as Partial<Applied>;
  return { ok: res.ok && r.ok !== false, version, ...(r.error ? { error: r.error } : {}) };
}

/** The window runs the target CLI detached; its result is read back until it ends. */
async function throughWindow(host: StudioBinding, version: string, wait: (ms: number) => Promise<void>): Promise<Applied> {
  if (!(await host.startuemcpupdate!(version).catch(() => false))) {
    return { ok: false, version, error: `Studio's window could not start ue-mcp ${version}'s update: Node.js or the project was not found.` };
  }
  for (let waited = 0; waited < WINDOW_UPDATE_MS; waited += POLL_MS) {
    await wait(POLL_MS);
    const text = await host.getuemcpupdate!().catch(() => "");
    if (!text) continue;
    try {
      const r = JSON.parse(text) as { ok?: boolean; error?: string };
      return { ok: r.ok === true, version, ...(r.error ? { error: r.error } : {}) };
    } catch {
      return { ok: false, version, error: `ue-mcp ${version}'s update ended with no result` };
    }
  }
  return { ok: false, version, error: `ue-mcp ${version}'s update did not finish in 15 minutes. Its output is in Saved/UE_MCP_Studio/ue-mcp-update.log.` };
}

/**
 * Install the newest ue-mcp on the floor's channel, or the floor itself when
 * the channel has nothing as new. The target release's own CLI installs its
 * bridge, never this daemon, which is the older ue-mcp: Studio's refusal
 * route runs it when an older daemon loaded Studio, Studio's window when the
 * daemon refused Studio. The daemon's own apply is left for a host with
 * neither, such as a plain browser or an older window.
 */
export async function updateUeMcp(
  needs: string,
  send: typeof fetch = fetch,
  host: StudioBinding = native(),
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Applied> {
  const channel = needs.includes("-") ? "beta" : "latest";
  const check = await send(`/v1/update?channel=${channel}`, { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<Check>) : null))
    .catch(() => null);
  const version = check?.latest && !isNewer(needs, check.latest) ? check.latest : needs;
  const own = await post(send, "/v1/ext/studio/refusal/update", { version });
  // 404: the daemon refused Studio, so no Studio route is loaded.
  if (own.status !== 404) return answered(own, version);
  if (host.startuemcpupdate && host.getuemcpupdate) return throughWindow(host, version, wait);
  return answered(await post(send, "/v1/update/apply", { version }), version);
}

type Step = { kind: "idle" } | { kind: "working" } | { kind: "done"; version: string } | { kind: "failed"; error: string };

export function RefusedScreen({ refusal }: { refusal: StudioRefusal }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const update = () => {
    setStep({ kind: "working" });
    void updateUeMcp(refusal.needs).then((r) =>
      setStep(r.ok ? { kind: "done", version: r.version } : { kind: "failed", error: r.error ?? "The update did not finish." }));
  };
  return (
    <div className="app">
      <main className="empty refused">
        <h1 className="refused-head">
          Studio needs ue-mcp <span className="version">{refusal.needs}</span>. You have <span className="version">{refusal.have}</span>.
        </h1>
        {step.kind === "done" ? (
          <p className="muted">ue-mcp {step.version} is installed. Restart the editor to finish.</p>
        ) : (
          <button className="primary large" onClick={update} disabled={step.kind === "working"}>
            {step.kind === "working" ? "Updating ue-mcp" : "Update ue-mcp"}
          </button>
        )}
        {step.kind === "failed" && <div className="banner bad small refused-error">{step.error}</div>}
      </main>
    </div>
  );
}
