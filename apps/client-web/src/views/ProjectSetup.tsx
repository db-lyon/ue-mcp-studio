import { useEffect, useState } from "react";
import { inEditor, native } from "../native";

/** The part of `ue-mcp init --dry-run`'s plan the page reads. */
interface SetupPlan {
  project: { engine: string | null };
  clients: { id: string; name: string; detected: boolean; projectScoped: boolean; selected: boolean }[];
  nativeTools: { enabled: boolean };
  contextStrategy: "micro" | "lean" | "full";
  feedback: boolean;
  skills: boolean;
}

const CONTEXT: { id: SetupPlan["contextStrategy"]; name: string; about: string }[] = [
  { id: "micro", name: "Micro", about: "One gateway tool fronts everything. Smallest context." },
  { id: "lean", name: "Lean", about: "Category tools and action names visible, signatures on demand." },
  { id: "full", name: "Full", about: "Every action's signature listed up front. Largest context, no discovery calls." },
];

const engineAtLeast = (v: string | null, major: number, minor: number): boolean => {
  const m = /^(\d+)\.(\d+)/.exec(v ?? "");
  return !!m && (+m[1] > major || (+m[1] === major && +m[2] >= minor));
};

/**
 * What `ue-mcp init` asks on the command line, for this project: which other MCP
 * clients to connect, the native Unreal tools, the context strategy and agent
 * behavior. The host reads the current state with a dry run and applies changes
 * by running init again.
 */
export function ProjectSetup({ onApplied }: { onApplied: () => void }) {
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [failed, setFailed] = useState(false);
  const [clients, setClients] = useState<Set<string>>(new Set());
  const [nativeTools, setNativeTools] = useState(true);
  const [context, setContext] = useState<SetupPlan["contextStrategy"]>("micro");
  const [feedback, setFeedback] = useState(false);
  const [skills, setSkills] = useState(false);
  const [status, setStatus] = useState<"idle" | "started" | "failed">("idle");

  useEffect(() => {
    if (!inEditor()) return;
    let stopped = false;
    const started = Date.now();
    const poll = async (): Promise<void> => {
      const raw = await native().getsetupplan?.();
      if (stopped) return;
      const parsed = raw ? (JSON.parse(raw) as { plan?: SetupPlan }) : null;
      if (parsed?.plan) {
        const p = parsed.plan;
        setPlan(p);
        // A global client's config applies to every project, so it is never chosen for the user.
        setClients(new Set(p.clients.filter((c) => c.selected && c.projectScoped).map((c) => c.id)));
        setNativeTools(p.nativeTools.enabled);
        setContext(p.contextStrategy);
        setFeedback(p.feedback);
        setSkills(p.skills);
      } else if (Date.now() - started > 90_000) {
        setFailed(true);
      } else {
        setTimeout(() => void poll(), 1000);
      }
    };
    void native().startsetupplan?.().then(() => poll());
    return () => {
      stopped = true;
    };
  }, []);

  if (!inEditor()) {
    return (
      <section className="card">
        <h2>Project setup</h2>
        <p className="muted">Open Studio in the editor to change which MCP clients and tools this project is set up with.</p>
      </section>
    );
  }
  if (failed) {
    return (
      <section className="card">
        <h2>Project setup</h2>
        <p className="muted">The current setup could not be read. The editor's Output Log has the reason.</p>
      </section>
    );
  }
  if (!plan) {
    return (
      <section className="card">
        <h2>Project setup</h2>
        <p className="muted">Reading this project's setup</p>
      </section>
    );
  }

  const detected = plan.clients.filter((c) => c.detected);
  const claudeCode = [...clients].some((id) => id.startsWith("claude-code"));
  const toggle = (id: string) => setClients((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const apply = () => {
    const options = { clients: [...clients], nativeTools, context, feedback, skills: claudeCode && skills };
    native().runsetup?.(JSON.stringify(options)).then((ok) => {
      setStatus(ok ? "started" : "failed");
      if (ok) setTimeout(onApplied, 20_000);
    }, () => setStatus("failed"));
  };

  return (
    <section className="card">
      <h2>Project setup</h2>
      <p className="muted small">The choices <span className="mono">ue-mcp init</span> asks for on the command line. Applying runs it again for this project.</p>

      <h3 className="subhead">Also connect these MCP clients</h3>
      {detected.length === 0 && <p className="dim small">No other MCP clients found on this machine.</p>}
      {detected.map((c) => (
        <label key={c.id} className="check">
          <input type="checkbox" checked={clients.has(c.id)} onChange={() => toggle(c.id)} />
          {c.name}
          {!c.projectScoped && <span className="dim small">applies to every project</span>}
        </label>
      ))}

      {engineAtLeast(plan.project.engine, 5, 8) && (
        <>
          <h3 className="subhead">Tools</h3>
          <label className="check">
            <input type="checkbox" checked={nativeTools} onChange={(e) => setNativeTools(e.target.checked)} />
            Native Unreal tools <span className="dim small">Epic's own MCP tools, alongside the bridge</span>
          </label>
        </>
      )}

      <h3 className="subhead">Context strategy for other clients</h3>
      {CONTEXT.map((t) => (
        <label key={t.id} className="check">
          <input type="radio" checked={context === t.id} onChange={() => setContext(t.id)} />
          {t.name} <span className="dim small">{t.about}</span>
        </label>
      ))}

      {claudeCode && <h3 className="subhead">For Claude Code</h3>}
      {claudeCode && (
        <label className="check">
          <input type="checkbox" checked={skills} onChange={(e) => setSkills(e.target.checked)} />
          Skills for Claude Code <span className="dim small">Workflow guides copied into .claude/skills</span>
        </label>
      )}

      <div className="actions">
        <button className="primary" disabled={status === "started"} onClick={apply}>Apply</button>
      </div>
      {status === "started" && <div className="banner ok">Running setup. The install status above refreshes when it is done.</div>}
      {status === "failed" && <div className="banner bad">Setup could not start. The editor's Output Log has the reason.</div>}
    </section>
  );
}
