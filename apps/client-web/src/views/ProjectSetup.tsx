import { useEffect, useState } from "react";
import { inEditor, native } from "../native";
import { obj } from "../normalize";

/** The part of `ue-mcp init --dry-run`'s plan the page reads. */
interface SetupPlan {
  project: { engine: string | null };
  clients: { id: string; name: string; detected: boolean; projectScoped: boolean; selected: boolean }[];
  nativeTools: { enabled: boolean };
  contextStrategy: "micro" | "lean" | "full";
  feedback: boolean;
  skills: boolean;
}

/** The plan from any ue-mcp's `init --dry-run`, each part it does not report left empty or off; null when there is none yet. */
export function planOf(raw: string | null | undefined): SetupPlan | null {
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
  const plan = obj(obj(parsed).plan);
  if (!Object.keys(plan).length) return null;
  const project = obj(plan.project);
  return {
    project: { engine: typeof project.engine === "string" ? project.engine : null },
    clients: (Array.isArray(plan.clients) ? plan.clients : []).map(obj).filter((c) => typeof c.id === "string").map((c) => ({
      id: c.id as string,
      name: typeof c.name === "string" ? c.name : (c.id as string),
      detected: c.detected === true,
      projectScoped: c.projectScoped !== false,
      selected: c.selected === true,
    })),
    nativeTools: { enabled: obj(plan.nativeTools).enabled !== false },
    contextStrategy: plan.contextStrategy === "lean" || plan.contextStrategy === "full" ? plan.contextStrategy : "micro",
    feedback: plan.feedback === true,
    skills: plan.skills === true,
  };
}

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
      const p = planOf(raw);
      if (p) {
        setPlan(p);
        // A global client's config applies to every project, so it is never chosen for the user.
        setClients(new Set(p.clients.filter((c) => c.selected && c.projectScoped).map((c) => c.id)));
        setNativeTools(p.nativeTools.enabled);
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

  // Outside the editor the setup cannot be read or run; the MCP clients card says where to change it.
  if (!inEditor()) return null;
  if (failed) {
    return (
      <section className="card">
        <h2>Clients and tools setup</h2>
        <p className="muted">The current setup could not be read. The editor's Output Log has the reason.</p>
      </section>
    );
  }
  if (!plan) {
    return (
      <section className="card">
        <h2>Clients and tools setup</h2>
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
    // The context strategy is set on its own card above, in ue-mcp.yml, which init reads back: pass it through unchanged.
    const options = { clients: [...clients], nativeTools, context: plan.contextStrategy, feedback, skills: claudeCode && skills };
    native().runsetup?.(JSON.stringify(options)).then((ok) => {
      setStatus(ok ? "started" : "failed");
      if (ok) setTimeout(onApplied, 20_000);
    }, () => setStatus("failed"));
  };

  return (
    <section className="card">
      <h2>Clients and tools setup</h2>
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
