import { createContext, memo, useContext, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { lineDiff, type Attachment, type TranscriptEntry, type TurnStatus } from "@ue-mcp-studio/shared";
import { DiffView } from "./Diff";
import { breakable } from "./breakable";
import { DialogLine } from "./Dialogs";
import { QaCard } from "./Qa";
import { SessionIdContext, attachmentUrl, formatBytes, isImage } from "./attachments";
import {
  OUTCOME_LABEL,
  RESULT_PREVIEW_LINES,
  TOOL_TAG,
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
import { AssetAnchorContext, AssetTranscriptContext, remarkAssets } from "./asset-links";
import { AssetToken, ExactAssetLink, LinkedText } from "./AssetLink";
import type { Components } from "react-markdown";

/** Each entry's position in its transcript, built once per transcript rather than searched per entry. */
const positions = new WeakMap<readonly unknown[], Map<unknown, number>>();
function positionIn(transcript: readonly unknown[] | null | undefined, entry: TranscriptEntry): number {
  if (!transcript) return -1;
  let map = positions.get(transcript);
  if (!map) {
    map = new Map(transcript.map((e, i) => [e, i] as const));
    positions.set(transcript, map);
  }
  return map.get(entry) ?? -1;
}

/**
 * Sends an edit of one of the user's messages, by its transcript index: "rewind" cuts this
 * session back to it, "fork" continues from it in a copy. Null where messages cannot be edited.
 */
export type EditMode = "rewind" | "fork";
export const EditMessageContext = createContext<((index: number, text: string, mode: EditMode) => void) | null>(null);

/** One line of a conversation that is not a subagent: a message, a note or a tool call. Renders again only when the entry changes. */
export const Entry = memo(function Entry({ entry }: { entry: TranscriptEntry }) {
  const transcript = useContext(AssetTranscriptContext);
  if (entry.kind === "user") {
    const at = positionIn(transcript, entry);
    return <UserMessage entry={entry} at={at < 0 || entry.parent ? undefined : at} />;
  }
  if (entry.kind === "assistant") {
    const at = positionIn(transcript, entry);
    return <Reply text={entry.text} at={at < 0 ? undefined : at} />;
  }
  if (entry.kind === "note") return <div className="banner warn note">{entry.text}</div>;
  if (entry.kind === "dialog") return <DialogLine dialog={entry.dialog} />;
  if (entry.kind === "qa") return <QaCard run={entry.run} />;
  return <ToolCall call={entry.call} />;
});

/**
 * A message the user sent. Edit opens it in place. With anything after it,
 * saving asks where the edit goes: rewind this session to it (everything after
 * is removed, for the model too) or fork a new session from it and keep this one.
 */
function UserMessage({ entry, at }: { entry: Extract<TranscriptEntry, { kind: "user" }>; at?: number }) {
  const onEdit = useContext(EditMessageContext);
  const [text, setText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const transcript = useContext(AssetTranscriptContext);
  const last = at !== undefined && transcript ? transcript.length - 1 === at : false;
  const close = () => {
    setText(null);
    setConfirming(false);
  };
  if (text !== null && onEdit && at !== undefined) {
    const save = () => {
      if (!text.trim()) return;
      // Nothing after it to lose: no need to ask.
      if (last) {
        onEdit(at, text, "rewind");
        close();
      } else setConfirming(true);
    };
    return (
      <div className="msg user editing">
        {entry.attachments && entry.attachments.length > 0 && <SentFiles files={entry.attachments} />}
        <textarea
          aria-label="Edit your message"
          value={text}
          autoFocus
          rows={Math.min(12, Math.max(2, text.split("\n").length))}
          onChange={(e) => {
            setText(e.target.value);
            setConfirming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
            else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!confirming) save();
            }
          }}
        />
        {confirming ? (
          <div className="edit-confirm" role="alert">
            <span>
              <strong>Rewind here</strong> removes everything after this message from this session, for the agent too.{" "}
              <strong>Fork</strong> keeps this session as it is and continues from your edit in a new one.
              Either way, changes the agent already made to the project are not undone.
            </span>
            <div className="row">
              <button className="ghost small-button" onClick={() => setConfirming(false)}>Keep editing</button>
              <span className="spacer" />
              <button className="danger-button small-button" onClick={() => {
                onEdit(at, text, "rewind");
                close();
              }}>Rewind here</button>
              <button className="primary small-button" onClick={() => {
                onEdit(at, text, "fork");
                close();
              }}>Fork a new session</button>
            </div>
          </div>
        ) : (
          <div className="row">
            <span className="spacer" />
            <button className="ghost small-button" onClick={close}>Cancel</button>
            <button className="primary small-button" disabled={!text.trim()} onClick={save}>Save and send</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="msg user">
      {entry.attachments && entry.attachments.length > 0 && <SentFiles files={entry.attachments} />}
      {entry.text}
      {onEdit && at !== undefined && (
        <button className="msg-edit ghost small-button" aria-label="Edit this message" title="Edit and send again from here" onClick={() => setText(entry.text)}>Edit</button>
      )}
    </div>
  );
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

/**
 * Markdown links to object paths render as exact asset links; inline code and
 * bare object paths that name an asset render as links once resolved.
 */
const REPLY_COMPONENTS: Components = {
  code: ({ node: _node, children, ...props }) => {
    const token = (props as { "data-asset"?: string })["data-asset"];
    return token ? <AssetToken token={token} code /> : <code {...props}>{breakable(children)}</code>;
  },
  // Wide tables scroll in a wrapper of their own instead of squeezing their columns.
  table: ({ node: _node, children, ...props }) => <div className="md-table"><table {...props}>{children}</table></div>,
  span: ({ node: _node, children, ...props }) => {
    const exact = props as { "data-asset-path"?: string; "data-asset-label"?: string };
    if (exact["data-asset-path"]) return <ExactAssetLink path={exact["data-asset-path"]} label={exact["data-asset-label"] ?? ""} />;
    const token = (props as { "data-asset"?: string })["data-asset"];
    return token ? <AssetToken token={token} code={false} /> : <span {...props}>{children}</span>;
  },
};
const REPLY_PLUGINS = [remarkGfm, remarkBreaks, remarkAssets];

/**
 * A model reply, rendered as markdown without raw HTML; a single line break
 * stays a line break. at: its transcript index, for tracing the names in it.
 */
export const Reply = memo(function Reply({ text, at }: { text: string; at?: number }) {
  return (
    <AssetAnchorContext.Provider value={at}>
      <div className="msg assistant md"><Markdown remarkPlugins={REPLY_PLUGINS} components={REPLY_COMPONENTS}>{text}</Markdown></div>
    </AssetAnchorContext.Provider>
  );
});

/**
 * The main thread, following its newest line while the reader is at the
 * bottom, with a way back down when they have scrolled up.
 */
/** The conversation. Memoized: typing in the composer does not render it again. */
export const MainTranscript = memo(function MainTranscript({ transcript, status, streaming, waitingCause, error, onOpen, hidden, sent }: {
  transcript: TranscriptEntry[];
  status: TurnStatus;
  streaming: string;
  waitingCause: string | null;
  error: string | null;
  onOpen: (id: string) => void;
  hidden: boolean;
  /** Counts the reader's sends; each one snaps the thread to its newest line. */
  sent?: number;
}) {
  const items = useMemo(() => mainTimeline(transcript, status), [transcript, status]);
  const follow = useFollow<HTMLDivElement>(`${transcript.length}:${streaming.length}:${status}`, sent);
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
});

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

/** How a call's input reads when opened: the command, the change as a diff, or the input itself. */
function CallInput({ call, links }: { call: Call; links: boolean }) {
  const i = call.input as { command?: string; path?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean };
  if (call.name === "shell") return <pre className="output command">{`$ ${i.command ?? ""}`}</pre>;
  if (call.name === "edit_file") {
    return (
      <>
        {i.replace_all && <div className="dim small call-note">every occurrence</div>}
        <DiffView lines={lineDiff(i.old_string ?? "", i.new_string ?? "")} label={`Edit to ${i.path ?? ""}`} />
      </>
    );
  }
  if (call.name === "write_file") {
    const lines = (i.content ?? "").split("\n");
    const shown = lines.slice(0, WRITE_PREVIEW_LINES).map((text) => ({ op: "+" as const, text }));
    return <DiffView lines={lines.length > WRITE_PREVIEW_LINES ? [...shown, { op: "gap", count: lines.length - WRITE_PREVIEW_LINES }] : shown} label={`Content of ${i.path ?? ""}`} />;
  }
  if (call.name === "web_search" || call.name === "read_file" || call.name === "glob" || call.name === "grep" || call.name === "web_fetch") return null;
  return <pre className="output">{links ? <LinkedText text={JSON.stringify(call.input, null, 2)} /> : JSON.stringify(call.input, null, 2)}</pre>;
}

/** The images a call showed the model, as thumbnails that open the image. Shown with the call closed or open. */
function ShownImages({ files }: { files: Attachment[] }) {
  const sessionId = useContext(SessionIdContext);
  if (!sessionId) return null;
  return (
    <div className="tool-images" aria-label="Images the model saw">
      {files.map((f) => (
        <a key={f.id} className="tool-image" href={attachmentUrl(sessionId, f.id)} target="_blank" rel="noreferrer" title={`${f.name}, ${formatBytes(f.size)}, as the model saw it`}>
          <img src={attachmentUrl(sessionId, f.id)} alt={f.name} loading="lazy" />
        </a>
      ))}
    </div>
  );
}

/** How many lines of a written file the transcript shows. */
const WRITE_PREVIEW_LINES = 40;

/** A tool call: its label and outcome; open, its input and its result, long results shortened. */
export function ToolCall({ call }: { call: Call }) {
  const label = useMemo(() => toolLabel(call), [call]);
  // Paths in the input and result become links only while the call is open.
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  // A machine tool's result is text as it came; ue-mcp's is JSON, indented.
  const result = useMemo(() => (call.result ? (call.name === "ue_mcp" ? formatResult(call.result) : { text: call.result, lines: call.result.split("\n").length }) : null), [call.name, call.result]);
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
  const details = (
    <details className={`tool ${call.outcome}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="tool-name">{TOOL_TAG[call.name] ?? call.name}</span>
        <span className="tool-call">{label}</span>
        <span className="dim">{OUTCOME_LABEL[call.outcome]}</span>
      </summary>
      <CallInput call={call} links={open} />
      {result && (
        <div className="result">
          <div className="result-bar">
            <span className="dim small">{call.name === "shell" ? "Output" : "Result"}, {result.lines} {result.lines === 1 ? "line" : "lines"}</span>
            <button className="ghost small-button" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
          </div>
          <pre className="output">{open && shown ? <LinkedText text={shown} /> : shown}</pre>
          {result.lines > RESULT_PREVIEW_LINES && (
            <button className="ghost small-button" onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${result.lines} lines`}</button>
          )}
        </div>
      )}
    </details>
  );
  // A closed call hides what is inside it; the images it showed stay in view under it.
  if (!call.images?.length) return details;
  return (
    <div className="tool-with-images">
      {details}
      <ShownImages files={call.images} />
    </div>
  );
}
