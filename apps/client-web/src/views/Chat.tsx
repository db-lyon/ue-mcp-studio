import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionDetail, SessionSummary, StudioSettings, ToolCallRecord, TranscriptEntry } from "@ue-mcp-studio/shared";
import { api } from "../api";
import { ConnectModel, ModelPicker, useCatalog } from "./ModelPicker";
import type { DaemonState } from "../state";

/** Starting points shown on an empty session. Each is a single task the agent can finish through ue-mcp. */
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
    api.send(selected, text).then(() => loadDetail(selected), (e: Error) => {
      setDraft(text);
      setError(e.message);
    });
  };

  const busy = detail?.status === "running" || detail?.status === "waiting";

  return (
    <div className="chat">
      <aside className="card sessions">
        <div className="row">
          <h2>Sessions</h2>
          <span className="spacer" />
          <button className="primary" onClick={() => void create()}>New</button>
        </div>
        {sessions.length === 0 && <p className="dim small">No sessions yet.</p>}
        {sessions.map((s) => (
          <div key={s.id} className={`item ${s.id === selected ? "selected" : ""}`} onClick={() => setSelected(s.id)}>
            <strong>{s.title}</strong>
            <div className="muted small">
              {STATUS_LABEL[s.status] || new Date(s.updatedAt).toLocaleString()}
            </div>
          </div>
        ))}
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
            <div className="transcript">
              {detail.transcript.map((t, i) => <Entry key={i} entry={t} />)}
              {streaming && <div className="msg assistant">{streaming}</div>}
              {detail.status === "waiting" && (
                <div className="banner warn">Waiting for editor: {detail.waitingCause ?? "not connected"}. The turn continues when it is back.</div>
              )}
              {detail.status === "error" && detail.error && <div className="banner bad">{detail.error}</div>}
            </div>
            {settings && disconnected && <div className="composer-connect"><ConnectCard settings={settings} onSettings={setSettings} /></div>}
            <div className="composer">
              <textarea
                value={draft}
                placeholder={busy ? "The agent is working. You can stop it." : "Ask for something in the editor"}
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
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "user") return <div className="msg user">{entry.text}</div>;
  if (entry.kind === "assistant") return <div className="msg assistant">{entry.text}</div>;
  if (entry.kind === "note") return <div className="banner warn note">{entry.text}</div>;
  return <ToolCall call={entry.call} />;
}

const OUTCOME: Record<ToolCallRecord["outcome"], string> = {
  pending: "running",
  done: "done",
  error: "failed",
  unknown: "outcome unknown",
};

function ToolCall({ call }: { call: ToolCallRecord }) {
  const label = useMemo(() => {
    const i = call.input as { action?: string; category?: string; method?: string; query?: string; operation?: string };
    if (call.name === "editor_restart") return `editor ${i.operation ?? ""}`;
    if (i.action === "call") return `${i.category}.${i.method}`;
    if (i.action === "search") return `search "${i.query ?? ""}"`;
    return `describe ${i.category ?? ""}${i.method ? `.${i.method}` : ""}`;
  }, [call]);
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
