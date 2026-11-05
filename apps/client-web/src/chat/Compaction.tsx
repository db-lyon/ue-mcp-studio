import { createContext, useContext, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TranscriptEntry } from "@ue-mcp-studio/shared";
import { formatDuration, tokenCount } from "@ue-mcp-studio/client-core";

type CompactionEntry = Extract<TranscriptEntry, { kind: "compaction" }>;

const TRIGGER: Record<CompactionEntry["trigger"], string> = {
  auto: "automatic",
  manual: "by you",
  overflow: "the request was too long",
};

/** Compact now, for Try again on a failed compaction; null where nothing can be sent. */
export const CompactContext = createContext<(() => void) | null>(null);

const time = (at: string): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Where a conversation was compacted: a divider across the transcript with
 * the tokens before and after and when, opened to show the summary the agent
 * works from since. Everything above it stays on screen; only the model's
 * view was replaced. While it runs it says so; a failure says why, with Try again.
 */
export function CompactionMarker({ entry }: { entry: CompactionEntry }) {
  const [open, setOpen] = useState(false);
  const retry = useContext(CompactContext);
  const running = entry.state === "running";
  const failed = entry.state === "failed";
  const title = running ? "Compacting context" : failed ? "Compaction failed" : entry.method === "truncated" ? "Context trimmed" : "Context compacted";
  const numbers = running
    ? `${tokenCount(entry.before)} tokens, summarising`
    : entry.after !== undefined ? `${tokenCount(entry.before)} → ${tokenCount(entry.after)} tokens` : `${tokenCount(entry.before)} tokens before`;
  const expandable = !running && (!!entry.summary || failed || entry.method === "runtime");
  return (
    <div className={`compaction state-${entry.state}`} role="separator" aria-label={`${title}, ${numbers}, ${time(entry.at)}`}>
      <button className="compaction-line" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen(!open)}>
        <span className="compaction-rule" aria-hidden="true" />
        <span className="compaction-label">
          {expandable && <span className="compaction-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>}
          {running && <span className="compaction-dot" aria-hidden="true" />}
          <strong>{title}</strong>
          <span className="compaction-meta">{numbers}</span>
          <span className="compaction-meta dim">{TRIGGER[entry.trigger]}, {time(entry.at)}</span>
          {expandable && <span className="compaction-show">{open ? "Hide" : failed ? "Why" : "Summary"}</span>}
        </span>
        <span className="compaction-rule" aria-hidden="true" />
      </button>
      {open && (
        <div className="compaction-body">
          {failed && (
            <div className="compaction-failed">
              <span>{entry.error ?? "The conversation could not be compacted."} Nothing was cut; the agent still has the whole conversation.</span>
              {retry && !entry.parent && <button onClick={() => retry()}>Try again</button>}
            </div>
          )}
          {!failed && (
            <p className="dim small">
              {entry.method === "runtime" ? "Claude's runtime summarised the conversation" : entry.method === "truncated" ? "The summary could not be written, so the oldest part was cut" : `${entry.model ?? "The model"} summarised the conversation`}
              {entry.ms ? ` in ${formatDuration(Math.max(1, Math.round(entry.ms / 1000)))}` : ""}. The agent works from {entry.method === "truncated" ? "what is below" : "this summary"} and what follows; the transcript above is kept for you.
              {entry.instructions ? ` You asked it to keep: ${entry.instructions}` : ""}
              {entry.method === "truncated" && entry.error ? ` (${entry.error})` : ""}
            </p>
          )}
          {entry.summary
            ? <div className="compaction-summary md"><Markdown remarkPlugins={[remarkGfm]}>{entry.summary}</Markdown></div>
            : !failed && <p className="dim small">The runtime did not hand over its summary.</p>}
          {!failed && entry.summary && <button className="ghost small-button compaction-hide" onClick={() => setOpen(false)}>Hide summary</button>}
        </div>
      )}
    </div>
  );
}
