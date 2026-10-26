/**
 * Studio on a ue-mcp older than it needs: one screen, one button. The daemon
 * names the refusal in /v1/health (refusedExtensions) when it checks the
 * floor itself; an older daemon loads Studio, which then answers only
 * /v1/ext/studio/refusal. The button installs ue-mcp through the daemon's own
 * update routes, which work with no Studio routes at all.
 */
import { useEffect, useState } from "react";
import { isNewer, refusalInHealth, type RefusedExtension, type StudioRefusal } from "@ue-mcp-studio/shared";

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

/** Install the newest ue-mcp on the floor's channel, or the floor itself when the channel has nothing as new. */
export async function updateUeMcp(needs: string, send: typeof fetch = fetch): Promise<Applied> {
  const channel = needs.includes("-") ? "beta" : "latest";
  const check = await send(`/v1/update?channel=${channel}`, { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<Check>) : null))
    .catch(() => null);
  const version = check?.latest && !isNewer(needs, check.latest) ? check.latest : needs;
  const res = await send("/v1/update/apply", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  }).catch((e: Error) => new Response(JSON.stringify({ error: e.message }), { status: 500 }));
  const r = (await res.json().catch(() => ({}))) as Partial<Applied>;
  return { ok: res.ok && r.ok !== false, version, ...(r.error ? { error: r.error } : {}) };
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
