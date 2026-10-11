import { useContext, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import type { Attachment, TranscriptEntry, TurnStatus } from "@ue-mcp-studio/shared";
import { SessionIdContext, attachmentUrl, formatBytes, isImage } from "./attachments";
import {
  OUTCOME_LABEL,
  RESULT_PREVIEW_LINES,
  STATE_LABEL,
  agentStatus,
  callsIn,
  describe,
  formatDuration,
  formatResult,
  isActive,
  mainTimeline,
  summarize,
  toolLabel,
  type Call,
} from "./model";
import { useFollow, useNow } from "./hooks";

/** One line of a conversation that is not a subagent: a message, a note or a tool call. */
export function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.kind === "user") {
    return (
      <div className="msg user">
        {entry.attachments && entry.attachments.length > 0 && <SentFiles files={entry.attachments} />}
        {entry.text}
      </div>
    );
  }
  if (entry.kind === "assistant") return <Reply text={entry.text} />;
  if (entry.kind === "note") return <div className="banner warn note">{entry.text}</div>;
  return <ToolCall call={entry.call} />;
}

/** The files a message carried: images as thumbnails, the rest by name. Each opens the file. */
function SentFiles({ files }: { files: Attachment[] }) {
  const sessionId = useContext(SessionIdContext);
  return (
    <div className="sent-files">
      {files.map((f) => {
        const url = sessionId ? attachmentUrl(sessionId, f.id) : undefined;
        return (
          <a key={f.id} className="sent-file" href={url} target="_blank" rel="noreferrer" title={`${f.name}, ${formatBytes(f.size)}`}>
            {isImage(f.type) && url ? <img src={url} alt={f.name} /> : <span>{f.name} <span className="dim">{formatBytes(f.size)}</span></span>}
          </a>
        );
      })}
    </div>
  );
}

/** A model reply, rendered as markdown without raw HTML; a single line break stays a line break. */
export function Reply({ text }: { text: string }) {
  return <div className="msg assistant md"><Markdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</Markdown></div>;
}

/**
 * The main thread, following its newest line while the reader is at the
 * bottom, with a way back down when they have scrolled up.
 */
export function MainTranscript({ transcript, status, streaming, waitingCause, error, onOpen, hidden }: {
  transcript: TranscriptEntry[];
  status: TurnStatus;
  streaming: string;
  waitingCause: string | null;
  error: string | null;
  onOpen: (id: string) => void;
  hidden: boolean;
}) {
  const items = useMemo(() => mainTimeline(transcript, status), [transcript, status]);
  const follow = useFollow<HTMLDivElement>(`${transcript.length}:${streaming.length}:${status}`);
  const waiting = status === "waiting";
  return (
    <>
      <div className="transcript" ref={follow.ref} onScroll={follow.onScroll} aria-hidden={hidden || undefined}>
        {items.map((item, i) => {
          if (item.kind === "entry") return <Entry key={i} entry={item.entry} />;
          if (item.kind === "progress") return <ProgressFold key={i} entries={item.entries} />;
          return <AgentGroup key={item.calls[0].id} calls={item.calls} transcript={transcript} sessionWaiting={waiting} onOpen={onOpen} />;
        })}
        {streaming && <div className="msg assistant">{streaming}</div>}
        {waiting && <div className="banner warn">Waiting for editor: {waitingCause ?? "not connected"}. The turn continues when it is back.</div>}
        {status === "error" && error && <div className="banner bad">{error}</div>}
      </div>
      {follow.behind && <button className="jump-latest" onClick={follow.jump}>New messages {"↓"}</button>}
    </>
  );
}

/** The main agent's progress messages from a finished turn, folded behind its final answer. */
export function ProgressFold({ entries }: { entries: TranscriptEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="progress-fold">
      <button className="fold-toggle dim small" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agents-caret">{open ? "▾" : "▸"}</span>
        {entries.length} progress {entries.length === 1 ? "update" : "updates"}
      </button>
      {open && entries.map((e, i) => <Entry key={i} entry={e} />)}
    </div>
  );
}

/** Groups larger than this start collapsed once every subagent in them has finished. */
export const GROUP_OPEN_MAX = 3;

/** Subagents the main agent started together: one header, and a row per subagent. */
export function AgentGroup({ calls, transcript, sessionWaiting, onOpen }: {
  calls: Call[];
  transcript: TranscriptEntry[];
  sessionWaiting: boolean;
  onOpen: (id: string) => void;
}) {
  const now = useNow(calls.some((c) => c.outcome === "pending"));
  const rows = calls.map((c) => ({ call: c, ...agentStatus(c, transcript, sessionWaiting, now) }));
  const running = rows.some((r) => isActive(r.state));
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (running || calls.length <= GROUP_OPEN_MAX);
  if (calls.length === 1) return <AgentLink row={rows[0]} transcript={transcript} onOpen={onOpen} />;
  return (
    <div className="agent-group">
      <button className="agent-group-head" aria-expanded={open} onClick={() => setToggled(!open)}>
        <span className="agents-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{calls.length} subagents</span>
        <span className="dim">{summarize(rows.map((r) => r.state))}</span>
      </button>
      {open && rows.map((r) => <AgentLink key={r.call.id} row={r} transcript={transcript} onOpen={onOpen} />)}
    </div>
  );
}

type Row = { call: Call } & ReturnType<typeof agentStatus>;

/** In the main thread, a subagent is one line; its work is in its own thread. */
function AgentLink({ row, transcript, onOpen }: { row: Row; transcript: TranscriptEntry[]; onOpen: (id: string) => void }) {
  const calls = callsIn(transcript, row.call.id);
  return (
    <button className={`tool agent-link state-${row.state}`} onClick={() => onOpen(row.call.id)}>
      <span className="tool-name">subagent</span>
      <span className="tool-call">{describe(row.call)}</span>
      <span className="agents-state">{STATE_LABEL[row.state]}</span>
      <span className="dim">{row.activity ? `${row.activity}, ` : ""}{calls} {calls === 1 ? "call" : "calls"}, {formatDuration(row.secs)}</span>
      <span className="agent-open">Open thread {"›"}</span>
    </button>
  );
}

/** A subagent's own thread: the task it was given, its steps, and what it reported back. */
export function SubagentThread({ call, transcript, sessionWaiting, onBack, onStop }: {
  call: Call;
  transcript: TranscriptEntry[];
  sessionWaiting: boolean;
  onBack: () => void;
  onStop: (id: string) => void;
}) {
  const now = useNow(call.outcome === "pending");
  const st = agentStatus(call, transcript, sessionWaiting, now);
  const prompt = (call.input as { prompt?: string }).prompt;
  const steps = transcript.filter((t) => t.parent === call.id);
  const follow = useFollow<HTMLDivElement>(`${steps.length}:${call.outcome}`);
  return (
    <>
      <div className={`thread-head state-${st.state}`}>
        <button className="thread-back" onClick={onBack}>{"‹"} Main</button>
        <span className="agents-dot" />
        <strong>{describe(call)}</strong>
        <span className="agents-state">{STATE_LABEL[st.state]}</span>
        <span className="dim small">{st.activity ? `${st.activity}, ` : ""}{formatDuration(st.secs)}</span>
        <span className="spacer" />
        {isActive(st.state) && <button className="thread-stop" onClick={() => onStop(call.id)}>Stop</button>}
      </div>
      <div className="transcript" ref={follow.ref} onScroll={follow.onScroll}>
        {prompt && (
          <div className="msg user">
            <div className="eyebrow">Task from the main agent</div>
            {prompt}
          </div>
        )}
        {steps.map((t, i) => <Entry key={i} entry={t} />)}
        {call.outcome === "done" && <div className="dim small">Reported back to the main agent.</div>}
        {call.outcome === "stopped" && <div className="dim small">Stopped. The main agent was told.</div>}
        {(call.outcome === "error" || call.outcome === "unknown") && call.result && <div className="banner bad">{call.result}</div>}
      </div>
      {follow.behind && <button className="jump-latest" onClick={follow.jump}>New messages {"↓"}</button>}
    </>
  );
}

/** A tool call: its label and outcome; open, its input and its result, long results shortened. */
export function ToolCall({ call }: { call: Call }) {
  const label = useMemo(() => toolLabel(call), [call]);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const result = useMemo(() => (call.result ? formatResult(call.result) : null), [call.result]);
  const shown = result && !all && result.lines > RESULT_PREVIEW_LINES
    ? result.text.split("\n").slice(0, RESULT_PREVIEW_LINES).join("\n")
    : result?.text;
  const copy = () => {
    if (!result) return;
    void navigator.clipboard?.writeText(result.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <details className={`tool ${call.outcome}`}>
      <summary>
        <span className="tool-name">ue-mcp</span>
        <span className="tool-call">{label}</span>
        <span className="dim">{OUTCOME_LABEL[call.outcome]}</span>
      </summary>
      <pre className="output">{JSON.stringify(call.input, null, 2)}</pre>
      {result && (
        <div className="result">
          <div className="result-bar">
            <span className="dim small">Result, {result.lines} {result.lines === 1 ? "line" : "lines"}</span>
            <button className="ghost small-button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <pre className="output">{shown}</pre>
          {result.lines > RESULT_PREVIEW_LINES && (
            <button className="ghost small-button" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${result.lines} lines`}</button>
          )}
        </div>
      )}
    </details>
  );
}
