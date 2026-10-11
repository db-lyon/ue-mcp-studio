import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SessionDetail, SessionSummary, SessionUpdate, StudioSettings, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { ConnectModel, ModelPicker, useCatalog } from "./ModelPicker";
import type { DaemonState } from "../state";

/** Starting points shown on an empty session. Each is a single task the agent can finish through ue-mcp. */
/** How long a subagent thread takes to slide in or out; matches .thread-drawer's transition. */
const DRAWER_MS = 260;

const EXAMPLES = [
  "Make a glowing orange material and put it on a sphere in the level",
  "Build a Niagara fire at the player start",
  "List every Blueprint that has no references",
];

const STATUS_LABEL: Record<string, string> = {
  idle: "",
  running: "Working...",
  waiting: "Waiting for editor",
  stopped: "Stopped",
  error: "Stopped on an error",
};

/** Events that change a session, keyed by the session they name. */
function sessionOf(data: Record<string, unknown>): string | null {
  return typeof data.sessionId === "string" ? data.sessionId : null;
}

export function ChatView({ daemon }: { daemon: DaemonState }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(0);
  const streamed = useRef("");
  const [streaming, setStreaming] = useState("");
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  /** The subagent thread on screen, by its agent call id; null is the main thread. */
  const [thread, setThread] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  /** The thread the drawer shows, kept while it slides out, and whether it is in. */
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const loadList = () => api.sessions().then((r) => setSessions(r.sessions), (e: Error) => setError(e.message));
  const loadDetail = (id: string) => api.session(id).then((d) => {
    setDetail(d);
    setDraft((cur) => (cur ? cur : d.draft));
  }, (e: Error) => setError(e.message));

  const loadSettings = () => api.settings().then(setSettings, () => setSettings(null));
  useEffect(() => {
    void loadList();
    void loadSettings();
  }, []);

  // Nothing connected runs the selected model yet.
  const disconnected = settings !== null && settings.route === null;

  useEffect(() => {
    if (!selected) return;
    // Another session opens on its main thread, with no drawer sliding out over it.
    setThread(null);
    setDrawerId(null);
    setDrawerOpen(false);
    setDraft("");
    streamed.current = "";
    setStreaming("");
    void loadDetail(selected);
  }, [selected]);

  // Follow the event stream: refetch on any change to the open session, collect streamed text.
  useEffect(() => {
    const fresh = daemon.events.filter((e) => e.id > seen.current);
    if (fresh.length === 0) return;
    seen.current = fresh[fresh.length - 1].id;
    let refetch = false;
    let relist = false;
    for (const e of fresh) {
      if (!e.type.startsWith("studio.")) continue;
      const id = sessionOf(e.data);
      if (e.type === "studio.session.changed") relist = true;
      if (e.type === "studio.settings.changed") void loadSettings();
      if (id !== selected) continue;
      if (e.type === "studio.turn.delta") {
        streamed.current += String(e.data.text ?? "");
      } else {
        if (e.type === "studio.transcript.added") streamed.current = "";
        refetch = true;
      }
    }
    setStreaming(streamed.current);
    if (refetch && selected) void loadDetail(selected);
    if (relist) void loadList();
  }, [daemon.events, selected]);

  // An example prompt lands as the new session's saved draft, so it is in the composer when the session opens.
  const create = (prompt?: string) => api.newSession().then(async (d) => {
    if (prompt) await api.saveDraft(d.id, prompt);
    void loadList();
    setSelected(d.id);
  }).catch((e: Error) => setError(e.message));

  const send = () => {
    if (!selected || !draft.trim() || disconnected) return;
    const text = draft;
    setDraft("");
    setThread(null);
    api.send(selected, text).then(() => loadDetail(selected), (e: Error) => {
      setDraft(text);
      setError(e.message);
    });
  };

  const busy = detail?.status === "running" || detail?.status === "waiting";
  const live = sessions.filter((s) => !s.archived);
  const archived = sessions.filter((s) => s.archived);
  // After a rename, archive or delete: list again, and close the open session if it is gone.
  const changed = (deleted?: string) => {
    if (deleted && deleted === selected) {
      setSelected(null);
      setDetail(null);
    }
    void loadList();
  };
  const openThread = (thread && detail && agentCalls(detail.transcript).find((c) => c.id === thread)) || null;
  const drawerCall = (drawerId && detail && agentCalls(detail.transcript).find((c) => c.id === drawerId)) || null;

  // A subagent thread is a drawer over the main thread: mounted off screen, then slid in;
  // slid out, then unmounted once the slide has finished.
  useEffect(() => {
    if (thread) {
      setDrawerId(thread);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setDrawerOpen(true)));
      return () => cancelAnimationFrame(raf);
    }
    setDrawerOpen(false);
    const t = setTimeout(() => setDrawerId(null), DRAWER_MS);
    return () => clearTimeout(t);
  }, [thread]);

  return (
    <div className="chat">
      <aside className="card sessions">
        <div className="row">
          <h2>Sessions</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => void create()}>New</button>
        </div>
        {sessions.length === 0 && <p className="dim small">No sessions yet.</p>}
        {live.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selected} onOpen={() => setSelected(s.id)} onChanged={changed} />)}
        {archived.length > 0 && (
          <>
            <button className="sessions-fold dim small" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
              <span className="agents-caret">{showArchived ? "\u25be" : "\u25b8"}</span>
              Archived ({archived.length})
            </button>
            {showArchived && archived.map((s) => <SessionRow key={s.id} s={s} selected={s.id === selected} onOpen={() => setSelected(s.id)} onChanged={changed} />)}
          </>
        )}
      </aside>
      <section className="card conversation">
        {error && <div className="banner bad" onClick={() => setError(null)}>{error}</div>}
        {!detail && (
          <div className="empty">
            <h1 className="display"><em>Start</em> a session.</h1>
            <p className="muted">The agent works in this project through ue-mcp: Blueprints, materials, levels, Niagara and more.</p>
            {settings && disconnected && <ConnectCard settings={settings} onSettings={setSettings} />}
            {settings && !disconnected && <ModelPicker settings={settings} onSettings={setSettings} />}
            <button className="primary large" onClick={() => void create()}>New session</button>
            <div className="examples">
              {EXAMPLES.map((x) => (
                <button key={x} className="example" onClick={() => void create(x)}>{x}</button>
              ))}
            </div>
          </div>
        )}
        {detail && (
          <>
            <div className="thread-stage">
              <div className="transcript" aria-hidden={drawerOpen || undefined}>
                {detail.transcript.map((t, i) => (t.parent ? null : <Entry key={i} entry={t} transcript={detail.transcript} onOpen={setThread} sessionWaiting={detail.status === "waiting"} />))}
                {streaming && <div className="msg assistant">{streaming}</div>}
                {detail.status === "waiting" && (
                  <div className="banner warn">Waiting for editor: {detail.waitingCause ?? "not connected"}. The turn continues when it is back.</div>
                )}
                {detail.status === "error" && detail.error && <div className="banner bad">{detail.error}</div>}
              </div>
              {drawerCall && (
                <div className={`thread-drawer ${drawerOpen ? "open" : ""}`}>
                  <SubagentThread call={drawerCall} transcript={detail.transcript} onBack={() => setThread(null)} />
                </div>
              )}
            </div>
            {settings && disconnected && <div className="composer-connect"><ConnectCard settings={settings} onSettings={setSettings} /></div>}
            <div className="composer">
              <textarea
                value={draft}
                placeholder={busy ? "The agent is working. You can stop it." : openThread ? "Message the main agent" : "Ask for something in the editor"}
                disabled={busy}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => selected && void api.saveDraft(selected, draft)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-bar">
                {settings && <ModelPicker settings={settings} onSettings={setSettings} up />}
                <span className="spacer" />
                {busy
                  ? <button onClick={() => selected && void api.stop(selected)}>Stop</button>
                  : <button className="primary" disabled={!draft.trim() || disconnected} onClick={send}>Send</button>}
              </div>
              <Threads transcript={detail.transcript} thread={openThread ? thread : null} onThread={setThread} sessionWaiting={detail.status === "waiting"} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}

/**
 * One session in the list: open it, or from its menu rename, archive (or
 * restore) and delete it. Delete asks once more before it removes anything.
 */
function SessionRow({ s, selected, onOpen, onChanged }: {
  s: SessionSummary;
  selected: boolean;
  onOpen: () => void;
  onChanged: (deleted?: string) => void;
}) {
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setMenu(false);
        setConfirm(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const update = (u: SessionUpdate) => api.updateSession(s.id, u).then(() => onChanged(), () => onChanged());
  const rename = () => {
    setEditing(false);
    if (title.trim() && title.trim() !== s.title) void update({ title: title.trim() });
    else setTitle(s.title);
  };
  const remove = () => api.deleteSession(s.id).then(() => onChanged(s.id), () => onChanged());

  return (
    <div ref={box} className={`item ${selected ? "selected" : ""} ${s.archived ? "archived" : ""}`} onClick={() => !editing && onOpen()}>
      {editing ? (
        <input
          className="session-title-edit"
          autoFocus
          value={title}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={rename}
          onKeyDown={(e) => {
            if (e.key === "Enter") rename();
            if (e.key === "Escape") {
              setTitle(s.title);
              setEditing(false);
            }
          }}
        />
      ) : (
        <strong>{s.title}</strong>
      )}
      <div className="muted small">{STATUS_LABEL[s.status] || new Date(s.updatedAt).toLocaleString()}</div>
      <button
        className={`session-more ${menu ? "open" : ""}`}
        aria-label="Session actions"
        onClick={(e) => {
          e.stopPropagation();
          setMenu(!menu);
          setConfirm(false);
        }}
      >
        {"\u22ef"}
      </button>
      {menu && (
        <div className="session-menu" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => { setMenu(false); setEditing(true); }}>Rename</button>
          <button onClick={() => { setMenu(false); void update({ archived: !s.archived }); }}>{s.archived ? "Restore" : "Archive"}</button>
          <button className={`danger ${confirm ? "confirm" : ""}`} onClick={() => (confirm ? void remove() : setConfirm(true))}>
            {confirm ? "Delete for good" : "Delete"}
          </button>
        </div>
      )}
    </div>
  );
}

function Entry({ entry, transcript, onOpen, sessionWaiting = false }: { entry: TranscriptEntry; transcript: TranscriptEntry[]; onOpen: (id: string) => void; sessionWaiting?: boolean }) {
  if (entry.kind === "user") return <div className="msg user">{entry.text}</div>;
  if (entry.kind === "assistant") return <div className="msg assistant md"><Markdown remarkPlugins={[remarkGfm]}>{entry.text}</Markdown></div>;
  if (entry.kind === "note") return <div className="banner warn note">{entry.text}</div>;
  if (entry.call.name === "agent") return <AgentCall call={entry.call} transcript={transcript} onOpen={onOpen} sessionWaiting={sessionWaiting} />;
  return <ToolCall call={entry.call} />;
}

type Call = ToolCallRecord;
const describe = (c: Call) => (c.input as { description?: string }).description ?? "Subagent";
const callsIn = (transcript: TranscriptEntry[], id: string) => transcript.filter((t) => t.parent === id && t.kind === "tool").length;
const seconds = (c: Call) => (c.endedAt ? Math.max(1, Math.round((Date.parse(c.endedAt) - Date.parse(c.startedAt)) / 1000)) : null);

/** Every agent call in the session, in the order they started. */
function agentCalls(transcript: TranscriptEntry[]): Call[] {
  return transcript.flatMap((t) => (t.kind === "tool" && t.call.name === "agent" ? [t.call] : []));
}

/** What a subagent is doing now, read from its transcript entries. */
type AgentState = "working" | "waiting" | "stuck" | "done" | "failed" | "unknown";

/** A running subagent with nothing new for this long is shown as stuck. */
const STUCK_MS = 90_000;

const STATE_LABEL: Record<AgentState, string> = {
  working: "working",
  waiting: "waiting for editor",
  stuck: "stuck",
  done: "done",
  failed: "failed",
  unknown: "outcome unknown",
};

const timeOf = (t: TranscriptEntry): number => Date.parse(t.kind === "tool" ? t.call.endedAt ?? t.call.startedAt : t.at);

function agentStatus(call: Call, transcript: TranscriptEntry[], sessionWaiting: boolean, now: number): { state: AgentState; activity: string | null; secs: number } {
  const end = call.endedAt ? Date.parse(call.endedAt) : now;
  const secs = Math.max(1, Math.round((end - Date.parse(call.startedAt)) / 1000));
  if (call.outcome === "done") return { state: "done", activity: null, secs };
  if (call.outcome === "error") return { state: "failed", activity: null, secs };
  if (call.outcome === "unknown") return { state: "unknown", activity: null, secs };
  const steps = transcript.filter((t) => t.parent === call.id);
  const running = [...steps].reverse().find((t) => t.kind === "tool" && t.call.outcome === "pending");
  if (sessionWaiting) return { state: "waiting", activity: null, secs };
  if (running?.kind === "tool") return { state: "working", activity: toolLabel(running.call), secs };
  const last = Math.max(Date.parse(call.startedAt), ...steps.map(timeOf));
  if (now - last > STUCK_MS) return { state: "stuck", activity: `nothing new for ${Math.round((now - last) / 60_000) || 1}m`, secs };
  return { state: "working", activity: "thinking", secs };
}

const ACTIVE: AgentState[] = ["working", "waiting", "stuck"];

/** A clock that ticks every second while anything is running, for live elapsed times and stuck detection. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : Date.now();
}

/**
 * The threads of the session: the main agent, the subagents still running,
 * and the finished ones in a section that starts collapsed. A row switches
 * the conversation to that thread.
 */
function Threads({ transcript, thread, onThread, sessionWaiting }: {
  transcript: TranscriptEntry[];
  thread: string | null;
  onThread: (id: string | null) => void;
  sessionWaiting: boolean;
}) {
  const agents = agentCalls(transcript);
  const now = useNow(agents.some((a) => a.outcome === "pending"));
  const [showFinished, setShowFinished] = useState(false);
  if (agents.length === 0) return null;
  const rows = agents.map((a) => ({ call: a, ...agentStatus(a, transcript, sessionWaiting, now) }));
  const active = rows.filter((r) => ACTIVE.includes(r.state));
  const finished = rows.filter((r) => !ACTIVE.includes(r.state));
  const count = (st: AgentState) => rows.filter((r) => r.state === st).length;
  const failed = count("failed") + count("unknown");
  const summary = [
    count("working") && `${count("working")} working`,
    count("waiting") && `${count("waiting")} waiting`,
    count("stuck") && `${count("stuck")} stuck`,
    count("done") && `${count("done")} done`,
    failed && `${failed} failed`,
  ].filter(Boolean).join(", ");
  const open = showFinished || finished.some((r) => r.call.id === thread);

  const row = (r: (typeof rows)[number]) => {
    const calls = callsIn(transcript, r.call.id);
    return (
      <button key={r.call.id} role="tab" aria-selected={thread === r.call.id} className={`agents-row state-${r.state} ${thread === r.call.id ? "current" : ""}`} onClick={() => onThread(r.call.id)}>
        <span className="agents-dot" />
        <span className="agents-name">{describe(r.call)}</span>
        <span className="agents-state">{STATE_LABEL[r.state]}</span>
        {r.activity && <span className="agents-activity dim">{r.activity}</span>}
        <span className="agents-meta dim small">{calls} {calls === 1 ? "call" : "calls"}, {r.secs}s</span>
      </button>
    );
  };

  return (
    <div className="agents-bar" role="tablist">
      <div className="agents-head dim small">Subagents: {summary}</div>
      <button role="tab" aria-selected={thread === null} className={`agents-row main ${thread === null ? "current" : ""}`} onClick={() => onThread(null)}>
        <span className="agents-dot" />
        <span className="agents-name">Main</span>
      </button>
      {active.map(row)}
      {finished.length > 0 && (
        <>
          <button className="agents-fold dim small" aria-expanded={open} onClick={() => setShowFinished(!open)}>
            <span className="agents-caret">{open ? "\u25be" : "\u25b8"}</span>
            Finished ({finished.length}){failed > 0 && <span className="agents-failed">, {failed} failed</span>}
          </button>
          {open && finished.map(row)}
        </>
      )}
    </div>
  );
}

/** In the main thread, a subagent is one line; its work is in its own thread. */
function AgentCall({ call, transcript, onOpen, sessionWaiting }: { call: Call; transcript: TranscriptEntry[]; onOpen: (id: string) => void; sessionWaiting: boolean }) {
  const now = useNow(call.outcome === "pending");
  const st = agentStatus(call, transcript, sessionWaiting, now);
  const calls = callsIn(transcript, call.id);
  return (
    <button className={`tool agent-link state-${st.state}`} onClick={() => onOpen(call.id)}>
      <span className="tool-name">subagent</span>
      <span className="tool-call">{describe(call)}</span>
      <span className="agents-state">{STATE_LABEL[st.state]}</span>
      <span className="dim">{st.activity ? `${st.activity}, ` : ""}{calls} {calls === 1 ? "call" : "calls"}, {st.secs}s</span>
      <span className="agent-open">Open thread {"\u203a"}</span>
    </button>
  );
}

/** A subagent's own thread: the task it was given, its steps, and what it reported back. */
function SubagentThread({ call, transcript, onBack }: { call: Call; transcript: TranscriptEntry[]; onBack: () => void }) {
  const prompt = (call.input as { prompt?: string }).prompt;
  const steps = transcript.filter((t) => t.parent === call.id);
  const secs = seconds(call);
  return (
    <>
      <div className={`thread-head ${call.outcome}`}>
        <button className="thread-back" onClick={onBack}>{"‹"} Main</button>
        <strong>{describe(call)}</strong>
        <span className="dim small">subagent, {OUTCOME[call.outcome]}{secs ? `, ${secs}s` : ""}</span>
      </div>
      <div className="transcript">
        {prompt && (
          <div className="msg user">
            <div className="eyebrow">Task from the main agent</div>
            {prompt}
          </div>
        )}
        {steps.map((t, i) => <Entry key={i} entry={t} transcript={transcript} onOpen={() => {}} />)}
        {call.outcome === "pending" && <div className="dim small">Working</div>}
        {call.outcome === "done" && <div className="dim small">Reported back to the main agent.</div>}
        {call.outcome !== "pending" && call.outcome !== "done" && call.result && <div className="banner bad">{call.result}</div>}
      </div>
    </>
  );
}

const OUTCOME: Record<ToolCallRecord["outcome"], string> = {
  pending: "running",
  done: "done",
  error: "failed",
  unknown: "outcome unknown",
};

/** A tool call as one short line: the action it ran, the search it made, or what it described. */
function toolLabel(call: ToolCallRecord): string {
  const i = call.input as { action?: string; category?: string; method?: string; query?: string; operation?: string };
  if (call.name === "editor_restart") return `editor ${i.operation ?? ""}`;
  if (i.action === "call") return `${i.category}.${i.method}`;
  if (i.action === "search") return `search "${i.query ?? ""}"`;
  return `describe ${i.category ?? ""}${i.method ? `.${i.method}` : ""}`;
}

function ToolCall({ call }: { call: ToolCallRecord }) {
  const label = useMemo(() => toolLabel(call), [call]);
  return (
    <details className={`tool ${call.outcome}`}>
      <summary>
        <span className="tool-name">ue-mcp</span>
        <span className="tool-call">{label}</span>
        <span className="dim">{OUTCOME[call.outcome]}</span>
      </summary>
      <pre className="output">{JSON.stringify(call.input, null, 2)}</pre>
      {call.result && <pre className="output">{call.result}</pre>}
    </details>
  );
}

/** Nothing connected runs the selected model: sign in here (a key is the fallback), or pick another model. */
function ConnectCard({ settings, onSettings }: { settings: StudioSettings; onSettings: (s: StudioSettings) => void }) {
  const catalog = useCatalog(settings);
  return (
    <div className="keyform">
      <span className="eyebrow">Sign in to start</span>
      {catalog && (
        <ConnectModel
          catalog={catalog}
          vendor={settings.provider}
          model={settings.model}
          onConnected={() => void api.settings().then(onSettings)}
        />
      )}
      <div className="row connect-other">
        <span className="dim small">Or choose another model:</span>
        <ModelPicker settings={settings} onSettings={onSettings} />
      </div>
    </div>
  );
}
