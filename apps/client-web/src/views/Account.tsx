import { useEffect, useState } from "react";
import type { StudioAccountResponse } from "@ue-mcp-studio/shared";

/**
 * The signed-in account, its plan and usage against the period's quota. The
 * agent holds the ue-mcp token and asks the gateway; the page only reads the
 * agent's /account route, so the token never reaches it.
 */
async function loadAccount(): Promise<StudioAccountResponse | { error: string }> {
  const res = await fetch("/v1/ext/studio/account", { credentials: "same-origin" });
  if (res.status === 404) return { error: "This version of the Studio agent does not report accounts yet." };
  if (res.status === 502) return { error: "The UE-MCP account service could not be reached. Studio works with your own API key in the meantime." };
  if (!res.ok) return { error: ((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}` };
  return (await res.json()) as StudioAccountResponse;
}

const fmt = (n: number) => n.toLocaleString();

export function AccountView() {
  const [state, setState] = useState<StudioAccountResponse | { error: string } | null>(null);

  const load = () => {
    setState(null);
    loadAccount().then(setState, (e: Error) => setState({ error: e.message }));
  };
  useEffect(load, []);

  if (!state) return <p className="muted">Loading account...</p>;
  if ("error" in state) {
    return (
      <div className="stack">
        <section className="card">
          <h2>Account</h2>
          <p>{state.error}</p>
          <div className="actions"><button onClick={load}>Check again</button></div>
        </section>
      </div>
    );
  }
  if (!state.signedIn) {
    return (
      <div className="stack">
        <section className="card">
          <h2>Not signed in</h2>
          <p>{state.reason}</p>
          <p className="muted">
            Sign in from a terminal with <span className="mono">npx ue-mcp login</span>, then check again. Hosted models need a
            subscription; with your own API key Studio works without one.
          </p>
          <div className="actions">
            <button onClick={load}>Check again</button>
          </div>
        </section>
      </div>
    );
  }

  const u = state.usage;
  const pct = u.quota > 0 ? Math.min(100, Math.round((u.billableTokens / u.quota) * 100)) : 0;
  return (
    <div className="stack">
      <section className="card">
        <h2>Account</h2>
        <dl className="grid">
          <dt>Signed in as</dt><dd>@{u.login}</dd>
          <dt>Plan</dt><dd>{u.plan.name}{u.status === "past_due" ? " (payment past due)" : ""}</dd>
          <dt>Period</dt><dd>{new Date(u.periodStart).toLocaleDateString()} to {new Date(u.periodEnd).toLocaleDateString()}</dd>
        </dl>
        {state.manageUrl && (
          <div className="actions">
            <a href={state.manageUrl} target="_blank" rel="noreferrer"><button>Manage subscription</button></a>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Usage this period</h2>
        {u.quota > 0 ? (
          <>
            <div
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              style={{ height: 8, borderRadius: 4, background: "var(--panel-2)", border: "1px solid var(--line)", overflow: "hidden" }}
            >
              <div style={{ width: `${pct}%`, height: "100%", background: pct >= 90 ? "var(--bad)" : "var(--accent)" }} />
            </div>
            <p>{fmt(u.billableTokens)} of {fmt(u.quota)} tokens ({pct}%), {fmt(u.remaining)} left</p>
          </>
        ) : (
          <p>This plan has no hosted model tokens.</p>
        )}
        <dl className="grid">
          <dt>Input</dt><dd>{fmt(u.used.inputTokens)}</dd>
          <dt>Output</dt><dd>{fmt(u.used.outputTokens)}</dd>
          <dt>Cache writes</dt><dd>{fmt(u.used.cacheCreationInputTokens)}</dd>
          <dt>Cache reads</dt><dd>{fmt(u.used.cacheReadInputTokens)}</dd>
        </dl>
      </section>
    </div>
  );
}
