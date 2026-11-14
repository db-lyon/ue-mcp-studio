import { createContext, memo, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { MentionText } from "./MentionMenu";
import { lineDiff, type Attachment, type PlaytestRequest, type PlaytestStage, type TranscriptEntry, type TurnStatus } from "@ue-mcp-studio/shared";
import { DiffView } from "./Diff";
import { useAgents, useAsked } from "./asked";
import type { SessionAgent } from "@ue-mcp-studio/shared";
import { DialogLine } from "./Dialogs";
import { QaCard } from "./Qa";
import { TurnReviewCard } from "./TurnReview";
import { FlowCard } from "./FlowCommand";
import { CompactionMarker } from "./Compaction";
import { SessionIdContext, attachmentUrl, formatBytes, isImage } from "./attachments";
import {
  OUTCOME_LABEL,
  RESULT_PREVIEW_LINES,
  TOOL_TAG,
  STATE_LABEL,
  agentFor,
  agentView,
  callPath,
  describe,
  formatDuration,
  formatResult,
  isActive,
  liveStep,
  messageDeliveryNote,
  mainTimeline,
  stepActivity,
  stepsSummary,
  stepsTrouble,
  subagentTimeline,
  summarize,
  toolLabel,
  toolTitle,
  type Call,
  type ThreadItem,
} from "@ue-mcp-studio/client-core";
import { useFollow, useNow } from "./hooks";
import { AssetAnchorContext, AssetTranscriptContext } from "./asset-links";
import { ReplyMarkdown } from "./ReplyMarkdown";
import { LinkedText } from "./AssetLink";
import { useSlot } from "../extensions/registry";
import { Contribution } from "../extensions/Slot";

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

/** A row's key from its entry's place in the transcript, so rows keep their state as lines are added; the row index when the entry is not found. */
function placeKey(transcript: readonly unknown[], entry: TranscriptEntry, i: number): string {
  const p = positionIn(transcript, entry);
  return p < 0 ? `i${i}` : `e${p}`;
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
  // A deleted script's cards leave the conversation with it.
  if (entry.kind === "qa") return entry.run.deleted ? null : <QaCard run={entry.run} />;
  if (entry.kind === "review") return <TurnReviewCard review={entry.review} />;
  if (entry.kind === "playtest") {
    return entry.state === "failed"
      ? <PlaytestFailed errors={entry.errors?.length ? entry.errors : ["The playtest flow made no playtest."]} request={entry.request} />
      : <PlaytestProgress entry={entry} />;
  }
  if (entry.kind === "playtest-failed") return <PlaytestFailed errors={[entry.reason]} request={entry.request} />;
  if (entry.kind === "flow") return <FlowCard entry={entry} />;
  if (entry.kind === "card") return <ExtensionCard entry={entry} />;
  if (entry.kind === "compaction") return <CompactionMarker entry={entry} />;
  // A kind this client no longer draws, such as an older session's per-turn usage line.
  if (entry.kind !== "tool") return null;
  return <ToolCall call={entry.call} />;
});

/** A card an extension posted, drawn by the chat.card contribution for `${ext}:${type}`; nothing when none is registered. */
function ExtensionCard({ entry }: { entry: Extract<TranscriptEntry, { kind: "card" }> }) {
  const sessionId = useContext(SessionIdContext);
  const item = useSlot("chat.card").find((i) => i.ext === entry.ext && i.contribution.id === entry.type);
  const ctx = useMemo(() => ({ sessionId: sessionId ?? "", data: entry.data }), [sessionId, entry.data]);
  return item ? <Contribution item={item} ctx={ctx} /> : null;
}

/**
 * Runs a /playtest from a button: Retry on a failed one. `busy` while a turn
 * runs, when it cannot start. Null where nothing can be sent.
 */
export const PlaytestCommandContext = createContext<{ busy: boolean; run: (req: PlaytestRequest) => void } | null>(null);

/** The playtest flow's stages, in order, as the card names them. */
const PLAYTEST_STAGES: Array<[PlaytestStage, string]> = [
  ["gathering", "Gathering"],
  ["drafting", "Drafting"],
  ["checking", "Checking"],
  ["created", "Created"],
];

/** A /playtest while its flow runs: the stages, the one in progress marked, and the draft's attempt after a retry. */
function PlaytestProgress({ entry }: { entry: Extract<TranscriptEntry, { kind: "playtest" }> }) {
  const at = PLAYTEST_STAGES.findIndex(([s]) => s === entry.state);
  return (
    <div className="banner playtest-progress" role="status" aria-label="Playtest progress">
      <ol className="row small playtest-stages">
        {PLAYTEST_STAGES.map(([stage, label], i) => (
          <li key={stage} className={i < at || entry.state === "created" ? "done" : i === at ? "active" : "dim"} aria-current={i === at ? "step" : undefined}>
            {label}
            {stage === "drafting" && entry.attempt > 1 && ` (attempt ${entry.attempt})`}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A /playtest that saved no script: that it failed, the flow's errors, and Retry. */
function PlaytestFailed({ errors, request }: { errors: string[]; request: PlaytestRequest }) {
  const playtest = useContext(PlaytestCommandContext);
  return (
    <div className="banner bad playtest-failed" role="status">
      <div className="row">
        <strong>No playtest was made.</strong>
        <span className="spacer" />
        {playtest && <button className="small-button" disabled={playtest.busy} onClick={() => playtest.run(request)}>Retry</button>}
      </div>
      {errors.length === 1 ? <div className="small">{errors[0]}</div> : <ul className="small">{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>}
    </div>
  );
}

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
  // A message written in a subagent's thread says when it is not read yet, or never was.
  const delivery = entry.parent ? messageDeliveryNote(entry.delivery) : null;
  return (
    <div className="msg user">
      {entry.attachments && entry.attachments.length > 0 && <SentFiles files={entry.attachments} />}
      <MentionText text={entry.text} />
      {entry.source !== undefined && <span className="dim small msg-source"> from the agent's message above</span>}
      {delivery && <div className={`small msg-delivery${entry.delivery === "main" ? " undelivered" : " dim"}`} role="status">{delivery}</div>}
      {onEdit && at !== undefined && entry.source === undefined && (
        <button className="msg-edit icon-button" aria-label="Edit this message" title="Edit and send again from here" onClick={() => setText(entry.text)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.5 2.5l3 3L6 13H3v-3z" /></svg>
        </button>
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
 * A model reply, rendered as markdown without raw HTML; a single line break
 * stays a line break. at: its transcript index, for tracing the names in it.
 */
export const Reply = memo(function Reply({ text, at }: { text: string; at?: number }) {
  return (
    <AssetAnchorContext.Provider value={at}>
      <div className="msg assistant md"><ReplyMarkdown text={text} /></div>
    </AssetAnchorContext.Provider>
  );
});

/**
 * The main thread, following its newest line while the reader is at the
 * bottom, with a way back down when they have scrolled up.
 */
/** The conversation. Memoized: typing in the composer does not render it again. */
export const MainTranscript = memo(function MainTranscript({ transcript, status, streaming, waitingCause, error, onOpen, onStop, hidden, sent }: {
  transcript: TranscriptEntry[];
  status: TurnStatus;
  streaming: string;
  waitingCause: string | null;
  error: string | null;
  onOpen: (id: string) => void;
  /** Stop a running subagent, from its line. */
  onStop?: (id: string) => void;
  hidden: boolean;
  /** Counts the reader's sends; each one snaps the thread to its newest line. */
  sent?: number;
}) {
  const cards = useSlot("chat.card");
  const askedIds = useAsked();
  const items = useMemo(() => mainTimeline(transcript, (t) => t.kind !== "card" || cards.some((i) => i.ext === t.ext && i.contribution.id === t.type), askedIds), [transcript, cards, askedIds]);
  const follow = useFollow<HTMLDivElement>(`${transcript.length}:${streaming.length}:${status}`, sent);
  const waiting = status === "waiting";
  const asked = askedIds.size;
  return (
    <>
      <div className="transcript" ref={follow.ref} onScroll={follow.onScroll} aria-hidden={hidden || undefined}>
        <ThreadItems items={items} transcript={transcript} onOpen={onOpen} onStop={onStop} />
        {streaming && <div className="msg assistant">{streaming}</div>}
        {asked > 0 && <div className="banner warn" role="status">Waiting on you: {asked === 1 ? "a call needs" : `${asked} calls need`} your approval below.</div>}
        {waiting && <div className="banner warn">Waiting for editor: {waitingCause ?? "not connected"}. The turn continues when it is back.</div>}
        {status === "error" && error && <div className="banner bad">{error}</div>}
      </div>
      {follow.behind && <button className="jump-latest" onClick={follow.jump}>New messages {"↓"}</button>}
    </>
  );
});

/** A thread's lines, the main one or a subagent's, keyed by the entry or first call each starts at so a fold keeps its open state while the turn streams. */
function ThreadItems({ items, transcript, onOpen, onStop }: { items: ThreadItem[]; transcript: TranscriptEntry[]; onOpen?: (id: string) => void; onStop?: (id: string) => void }) {
  return (
    <>
      {items.map((item, i) => {
        if (item.kind === "entry") return <Entry key={placeKey(transcript, item.entry, i)} entry={item.entry} />;
        if (item.kind === "steps") return <StepsFold key={`s${item.calls[0].id}`} calls={item.calls} />;
        return <AgentGroup key={item.calls[0].id} calls={item.calls} onOpen={onOpen ?? (() => {})} onStop={onStop} />;
      })}
    </>
  );
}

/**
 * A run of tool calls as one line: what they did ("Ran 3 commands, edited 2
 * files"), what went wrong in the bad colour, and the step running now. Opened, every call.
 */
export function StepsFold({ calls }: { calls: Call[] }) {
  const [open, setOpen] = useState(false);
  const live = liveStep(calls);
  const trouble = stepsTrouble(calls);
  return (
    <div className={`steps-fold${live ? " running" : ""}`}>
      <button className="steps-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="agents-caret">{open ? "▾" : "▸"}</span>
        <span className="steps-summary">{stepsSummary(calls)}{trouble && <>, <span className="steps-trouble">{trouble}</span></>}</span>
        {live && <span className="steps-live" title={toolTitle(live)}><span>{stepActivity(live)}</span></span>}
      </button>
      {open && <div className="steps-list">{calls.map((c) => <ToolCall key={c.id} call={c} />)}</div>}
    </div>
  );
}

/** Groups larger than this start collapsed once every subagent in them has finished. */
export const GROUP_OPEN_MAX = 3;

/** Subagents the main agent started together: one header, and a row per subagent, each as the daemon's list says it is. */
export function AgentGroup({ calls, onOpen, onStop }: {
  calls: Call[];
  onOpen: (id: string) => void;
  onStop?: (id: string) => void;
}) {
  const now = useNow(calls.some((c) => c.outcome === "pending"));
  const agents = useAgents();
  const rows = calls.map((c) => {
    const agent = agentFor(agents, c);
    return { call: agent.call, steps: agent.steps, ...agentView(agent, now) };
  });
  const running = rows.some((r) => isActive(r.state));
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (running || calls.length <= GROUP_OPEN_MAX);
  if (calls.length === 1) return <AgentLink row={rows[0]} onOpen={onOpen} onStop={onStop} />;
  return (
    <div className="agent-group">
      <button className="agent-group-head" aria-expanded={open} onClick={() => setToggled(!open)}>
        <span className="agents-caret">{open ? "▾" : "▸"}</span>
        <span className="tool-name">{calls.length} subagents</span>
        <span className="dim">{summarize(rows.map((r) => r.state))}</span>
      </button>
      {open && rows.map((r) => <AgentLink key={r.call.id} row={r} onOpen={onOpen} onStop={onStop} />)}
    </div>
  );
}

type Row = { call: Call; steps: number } & ReturnType<typeof agentView>;

/** In the main thread, a subagent is one line; its work is in its own thread. A running one stops from here too. */
function AgentLink({ row, onOpen, onStop }: { row: Row; onOpen: (id: string) => void; onStop?: (id: string) => void }) {
  const calls = row.steps;
  const link = (
    <button className={`tool agent-link state-${row.state}`} onClick={() => onOpen(row.call.id)}>
      <span className="tool-name">subagent</span>
      <span className="tool-call">{describe(row.call)}</span>
      <span className="agents-state">{STATE_LABEL[row.state]}</span>
      <span className="dim">{row.activity ? `${row.activity}, ` : ""}{calls} {calls === 1 ? "call" : "calls"}, {formatDuration(row.secs)}</span>
      <span className="agent-open">Open thread {"›"}</span>
    </button>
  );
  if (!onStop || !isActive(row.state)) return link;
  return (
    <div className="agent-link-row">
      {link}
      <button className="agent-stop" aria-label={`Stop ${describe(row.call)}`} onClick={() => onStop(row.call.id)}>Stop</button>
    </div>
  );
}

/**
 * A subagent's own thread: the task it was given, its steps, and what it
 * reported back. `entries` is its thread as read by its id (ThreadLoader),
 * whatever part of the main transcript is held; `more` reads the page before.
 */
export function SubagentThread({ agent, entries, more, onBack, onStop }: {
  agent: SessionAgent;
  entries: TranscriptEntry[];
  more?: () => void;
  onBack: () => void;
  onStop: (id: string) => void;
}) {
  const call = agent.call;
  const now = useNow(call.outcome === "pending");
  const st = agentView(agent, now);
  const prompt = (call.input as { prompt?: string }).prompt;
  const asked = useAsked();
  const items = useMemo(() => subagentTimeline(entries, call.id, asked), [entries, call.id, asked]);
  const follow = useFollow<HTMLDivElement>(`${entries.length}:${call.outcome}`);
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
        {more ? (
          <button className="ghost thread-older" onClick={more}>Show earlier steps</button>
        ) : prompt && (
          <div className="msg user">
            <div className="eyebrow">Task from the main agent</div>
            {prompt}
          </div>
        )}
        <ThreadItems items={items} transcript={entries} />
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
  const i = call.input as { command?: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean };
  const path = callPath(call);
  if (call.name === "shell") return <pre className="output command">{`$ ${i.command ?? ""}`}</pre>;
  if (call.name === "edit_file") {
    return (
      <>
        {i.replace_all && <div className="dim small call-note">every occurrence</div>}
        <DiffView lines={lineDiff(i.old_string ?? "", i.new_string ?? "")} label={`Edit to ${path}`} />
      </>
    );
  }
  if (call.name === "write_file") {
    const lines = (i.content ?? "").split("\n");
    const shown = lines.slice(0, WRITE_PREVIEW_LINES).map((text) => ({ op: "+" as const, text }));
    return <DiffView lines={lines.length > WRITE_PREVIEW_LINES ? [...shown, { op: "gap", count: lines.length - WRITE_PREVIEW_LINES }] : shown} label={`Content of ${path}`} />;
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

/** The full result of a call whose long result the session left out, once it is opened; null until then. */
function useLazyResult(call: Call, open: boolean): string | null {
  const sessionId = useContext(SessionIdContext);
  const [fetched, setFetched] = useState<{ id: string; text: string } | null>(null);
  const want = open && call.result === undefined && call.resultSize !== undefined && !!sessionId && fetched?.id !== call.id;
  useEffect(() => {
    if (!want || !sessionId) return;
    let alive = true;
    api.callResult(sessionId, call.id).then(
      (r) => alive && setFetched({ id: call.id, text: r.result }),
      (e: Error) => alive && setFetched({ id: call.id, text: `Could not load the result: ${e.message}` }),
    );
    return () => {
      alive = false;
    };
  }, [want, sessionId, call.id]);
  return fetched?.id === call.id ? fetched.text : null;
}

/** How many lines of a written file the transcript shows. */
const WRITE_PREVIEW_LINES = 40;

/** A tool call: its label and outcome; open, its input and its result, long results shortened. */
export function ToolCall({ call }: { call: Call }) {
  const label = useMemo(() => toolLabel(call), [call]);
  const title = useMemo(() => toolTitle(call), [call]);
  // Paths in the input and result become links only while the call is open.
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  // A long result was left out of the session: fetched the first time the call is opened.
  const fetched = useLazyResult(call, open);
  const text = call.result ?? fetched ?? undefined;
  // A machine tool's result is text as it came; ue-mcp's is JSON, indented.
  const result = useMemo(() => (text ? (call.name === "ue_mcp" ? formatResult(text) : { text, lines: text.split("\n").length }) : null), [call.name, text]);
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
        <span className="tool-call" title={title}>{label}</span>
        <span className="dim">{OUTCOME_LABEL[call.outcome]}</span>
      </summary>
      <CallInput call={call} links={open} />
      {!result && call.resultSize !== undefined && open && <div className="dim small call-note" role="status">Loading the result, {formatBytes(call.resultSize)}</div>}
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
