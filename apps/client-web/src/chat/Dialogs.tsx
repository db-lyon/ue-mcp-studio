import { useEffect, useState } from "react";
import type { DialogAnswer, DialogBlock, EditorDialog } from "@ue-mcp-studio/shared";
import { api } from "../api";
import {
  NATIVE_DETAILS_LABEL,
  answerableHere,
  decider,
  dialogBannerLead,
  dialogBody,
  dialogEyebrow,
  nativeAfterLine,
  nativeDetails,
  nativeSummary,
  isPathCell,
  itemListShown,
  outcomeLine,
  readyIn,
  rowCheck,
  statusLine,
  tableColumns,
  tableHasChecks,
  tableWidth,
  tickableItems,
  whoLine,
} from "@ue-mcp-studio/client-core";

/** The open editor dialogs of one session, each a card with the dialog's own buttons. */
export function DialogCards({ dialogs, now }: { dialogs: EditorDialog[]; now: number }) {
  if (dialogs.length === 0) return null;
  return (
    <div className="approvals dialogs" role="region" aria-label="Editor dialogs">
      {dialogs.map((d) => <DialogCard key={d.id} dialog={d} now={now} />)}
    </div>
  );
}

/** Ticks the person changed on the card, by item index, and whether they may change them now. */
interface Ticks {
  ticks: Record<number, boolean>;
  canTick: boolean;
  onTick: (index: number, checked: boolean) => void;
}

/** One of the dialog's tables: its headings, its rows, and each row's checkbox. */
function DialogTable({ dialog: d, table: t, ticks }: { dialog: EditorDialog; table: Extract<DialogBlock, { type: "table" }>; ticks: Ticks }) {
  const columns = tableColumns(t);
  const width = tableWidth(t);
  const checks = tableHasChecks(t);
  return (
    <div className="dialog-table-wrap">
      <table className="dialog-table">
        {columns.length > 0 && (
          <thead>
            <tr>
              {checks && <th className="check" aria-label="Selected" />}
              {Array.from({ length: width }, (_, c) => <th key={c} scope="col">{columns[c] ?? ""}</th>)}
            </tr>
          </thead>
        )}
        <tbody>
          {t.rows.map((row, r) => {
            const check = rowCheck(d, t, r);
            const item = check?.item ?? null;
            return (
              <tr key={r}>
                {checks && (
                  <td className="check">
                    {check && (
                      <input
                        type="checkbox"
                        aria-label={`Select ${row[0] ?? `row ${r + 1}`}`}
                        checked={item !== null ? ticks.ticks[item] ?? check.checked : check.checked}
                        disabled={item === null || !ticks.canTick}
                        onChange={(e) => item !== null && ticks.onTick(item, e.target.checked)}
                      />
                    )}
                  </td>
                )}
                {Array.from({ length: width }, (_, c) => {
                  const cell = row[c] ?? "";
                  return <td key={c} className={isPathCell(cell) ? "mono" : undefined}>{cell}</td>;
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The dialog's body: ue-mcp's paragraphs and tables, or its flat text from an older ue-mcp. */
function DialogBody({ dialog: d, ticks }: { dialog: EditorDialog; ticks: Ticks }) {
  const body = dialogBody(d);
  if (body.kind === "text") return body.text ? <pre className="output dialog-message">{body.text}</pre> : null;
  return (
    <div className="dialog-body">
      {body.blocks.map((b, i) => b.type === "paragraph"
        ? <p key={i} className="dialog-paragraph">{b.text}</p>
        : <DialogTable key={i} dialog={d} table={b} ticks={ticks} />)}
    </div>
  );
}

/** Every transition so far, oldest first. */
function Steps({ dialog: d }: { dialog: EditorDialog }) {
  if (d.steps.length === 0) return null;
  return (
    <ol className="dialog-steps small" aria-label="What happened">
      {d.steps.map((s, i) => (
        <li key={i}>
          <span className="dim mono">{new Date(s.at).toLocaleTimeString()}</span> {s.text}
        </li>
      ))}
    </ol>
  );
}

/**
 * One dialog: its title, message and buttons, which call met it, and one line
 * that says who decides right now. A press is sent to ue-mcp, which presses
 * that button in the editor.
 */
export function DialogCard({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<number, boolean>>({});
  const rows = tickableItems(d);
  const who = decider(d);
  const wait = readyIn(d, now);

  // Asked while the user is elsewhere: the dialog.waiting notification tells them, under each device's rules (notify.ts).
  // A new phase can be answered again.
  useEffect(() => setSent(null), [who, d.held?.button]);

  const send = (label: string, answer: DialogAnswer) => {
    setSent(label);
    setError(null);
    api.answerDialog(d.id, answer).catch((e: Error) => {
      setSent(null);
      setError(e.message);
    });
  };
  const press = (button: string) => {
    const items = rows.length > 0 ? rows.map((i) => ({ index: i.index, checked: ticks[i.index] ?? i.checked })) : undefined;
    send(button, { answer: "press", button, ...(items ? { items } : {}) });
  };

  const meta = whoLine(d);
  const busy = sent !== null;
  const tickState: Ticks = {
    ticks,
    canTick: who === "you" && !busy,
    onTick: (index, checked) => setTicks({ ...ticks, [index]: checked }),
  };
  const summary = nativeSummary(d);
  const after = nativeAfterLine(d);
  const details = nativeDetails(d);
  return (
    <div className={`approval card dialog-card${d.native ? ` native ${d.native.kind}` : ""}`} role="group" aria-label={`${dialogEyebrow(d)}: ${d.title}`}>
      <div className="approval-head">
        <span className="eyebrow">{dialogEyebrow(d)}</span>
        {meta && <span className="dim small">met by {meta}</span>}
      </div>
      <strong className="dialog-title">{d.title || "(untitled dialog)"}</strong>
      {summary && <p className="dialog-summary">{summary}</p>}
      <DialogBody dialog={d} ticks={tickState} />
      {after && <p className="dialog-after small">{after}</p>}
      {details.length > 0 && (
        <details className="dialog-details">
          <summary className="small">{NATIVE_DETAILS_LABEL} ({details.length})</summary>
          <pre className="output mono">{details.join("\n")}</pre>
        </details>
      )}
      {rows.length > 0 && itemListShown(d) && (
        <div className="dialog-items" role="group" aria-label="Assets">
          {rows.map((i) => (
            <label key={i.index} className="row toggle small">
              <input
                type="checkbox"
                disabled={who !== "you" || busy}
                checked={ticks[i.index] ?? i.checked}
                onChange={(e) => setTicks({ ...ticks, [i.index]: e.target.checked })}
              />
              <span>{i.label}</span>
              <span className="dim mono">{i.cells.find((c) => c.startsWith("/"))}</span>
            </label>
          ))}
        </div>
      )}
      {/* who- prefixed: a bare "editor" class picked up the code editor's box styles. */}
      <div className={`dialog-status who-${who}`} role="status">{statusLine(d, now)}</div>
      {error && <div className="banner bad">{error}</div>}
      {d.held ? (
        <div className="row approval-actions">
          <button className="primary" disabled={busy} onClick={() => send(d.held!.button, { answer: "release" })}>Press {d.held.button} now</button>
          {d.buttons.filter((b) => b !== d.held!.button).map((b) => (
            <button key={b} disabled={busy} onClick={() => press(b)} title={`Override: press ${b} instead`}>{b} instead</button>
          ))}
        </div>
      ) : who === "you" ? (
        <div className="row approval-actions">
          {d.buttons.map((b, i) => (
            <button key={b} className={i === 0 ? "primary" : undefined} disabled={busy || wait > 0} onClick={() => press(b)}>{b}</button>
          ))}
          <button className="ghost" disabled={busy || wait > 0} onClick={() => send("delegate", { answer: "delegate" })} title="The agent picks the answer for this dialog">Let the agent decide</button>
        </div>
      ) : who === "agent" ? (
        <div className="row approval-actions">
          <span className="dim small">Answer it yourself:</span>
          {d.buttons.map((b) => <button key={b} disabled={busy} onClick={() => press(b)}>{b}</button>)}
        </div>
      ) : answerableHere(d) ? (
        <div className="row approval-actions">
          {d.buttons.map((b, i) => (
            <button key={b} className={i === 0 ? "primary" : undefined} disabled={busy} onClick={() => press(b)}>{b}</button>
          ))}
        </div>
      ) : null}
      <Steps dialog={d} />
    </div>
  );
}

/** A dialog in the transcript: what it asked, every transition, and how it ended. */
export function DialogLine({ dialog: d }: { dialog: EditorDialog }) {
  const meta = whoLine(d);
  const ended = outcomeLine(d);
  return (
    <div className="dialog-line" role="note">
      <span className="eyebrow">{dialogEyebrow(d)}</span> <strong>{d.title || "(untitled dialog)"}</strong>
      {meta && <span className="dim small"> met by {meta}</span>}
      <Steps dialog={d} />
      {ended && <div className="small">{ended}</div>}
    </div>
  );
}

/** The banner line while a dialog holds the editor: the same line the card says. */
export function DialogBannerLine({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  return (
    <div className="banner warn editor-banner dialog-banner" role="status">
      <span className="editor-banner-text">
        <strong>{dialogBannerLead(d)}</strong> {d.title || "(untitled dialog)"}
        <span className="dim"> {statusLine(d, now)}</span>
      </span>
    </div>
  );
}
