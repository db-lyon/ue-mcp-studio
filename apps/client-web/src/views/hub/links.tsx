/**
 * Tracker links as the hub draws them: compact chips (host and title) that
 * open in the system browser, and a small inline form to add one. The words
 * and the rules (what a URL may be, what a chip says) are client-core's.
 */
import { useState } from "react";
import type { TrackerLink } from "@ue-mcp-studio/shared";
import { HUB_LINK_COPY, LINK_RELS, linkChip, linkFromRow, type LinkRow } from "@ue-mcp-studio/client-core";
import { openExternal } from "../../native";
import { HubIcon } from "./parts";

/** Links as chips. `onRemove` adds a remove button to each; `max` folds the rest into "+n"; `compact` (a row) drops the host when there is a title. */
export function HubLinkChips({ links, onRemove, max, compact = false }: { links: readonly TrackerLink[] | undefined; onRemove?: (url: string) => void; max?: number; compact?: boolean }) {
  const all = links ?? [];
  if (all.length === 0) return null;
  const shown = max !== undefined ? all.slice(0, max) : all;
  return (
    <>
      {shown.map((l) => {
        const c = linkChip(l);
        return (
          <span key={l.url} className="hub-link-chip">
            <a href={l.url} target="_blank" rel="noopener noreferrer" title={`${c.host}\n${c.tip}\n${HUB_LINK_COPY.opens}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openExternal(l.url);
              }}>
              <HubIcon name="link" size={11} />
              {!(compact && c.label) && <span className="hub-link-host">{c.host}</span>}
              {c.label && <span className="hub-link-label">{c.label}</span>}
            </a>
            {onRemove && (
              <button type="button" className="hub-link-remove" aria-label={HUB_LINK_COPY.remove(c.label || c.host)} title={HUB_LINK_COPY.remove(c.label || c.host)} onClick={() => onRemove(l.url)}>
                <HubIcon name="close" size={10} />
              </button>
            )}
          </span>
        );
      })}
      {max !== undefined && all.length > max && <span className="hub-link-more small dim">+{all.length - max}</span>}
    </>
  );
}

/** "Add link": a button that opens a one-line form for a URL and an optional title. */
export function HubAddLink({ onAdd }: { onAdd: (link: TrackerLink) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setOpen(false);
    setUrl("");
    setTitle("");
    setError(null);
  };
  if (!open) return <button type="button" className="ghost small-button hub-link-add" onClick={() => setOpen(true)}><HubIcon name="plus" size={11} /> {HUB_LINK_COPY.addLink}</button>;
  const submit = async () => {
    const r = linkFromRow({ url, title });
    if ("error" in r) return setError(r.error);
    setBusy(true);
    try {
      await onAdd(r.link);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="hub-link-form" noValidate
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}>
      <input autoFocus className="hub-link-url" value={url} onChange={(e) => { setUrl(e.target.value); setError(null); }} placeholder={HUB_LINK_COPY.urlPlaceholder} aria-label={HUB_LINK_COPY.urlLabel} aria-invalid={!!error} />
      <input className="hub-link-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={HUB_LINK_COPY.titlePlaceholder} aria-label={HUB_LINK_COPY.titleLabel} />
      <button type="submit" className="small-button" disabled={busy || !url.trim()}>{HUB_LINK_COPY.add}</button>
      <button type="button" className="ghost small-button" onClick={close}>{HUB_LINK_COPY.cancel}</button>
      {error && <span className="hub-error" role="alert">{error}</span>}
    </form>
  );
}

/**
 * A screen's links: a label, the chips with their remove buttons, and Add
 * link. Without `onAdd` (a check no goal lists yet) `note` says why.
 */
export function HubLinks({ links, onAdd, onRemove, note }: { links: readonly TrackerLink[] | undefined; onAdd?: (link: TrackerLink) => Promise<void>; onRemove?: (url: string) => void; note?: string }) {
  return (
    <div className="hub-links" role="group" aria-label={HUB_LINK_COPY.links}>
      <span className="dim small">{HUB_LINK_COPY.links}</span>
      <HubLinkChips links={links} onRemove={onRemove} />
      {onAdd ? <HubAddLink onAdd={onAdd} /> : note ? <span className="dim small">{note}</span> : null}
    </div>
  );
}

/** The goal dialog's links: a row per link with its URL, title and relationship. */
export function HubLinkRows({ rows, onChange, error }: { rows: LinkRow[]; onChange: (rows: LinkRow[]) => void; error?: string }) {
  const set = (i: number, k: keyof LinkRow, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  return (
    <fieldset className="hub-fieldset hub-link-rows">
      <legend>{HUB_LINK_COPY.links}</legend>
      <datalist id="hub-link-rels">{LINK_RELS.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</datalist>
      {rows.map((r, i) => (
        <div key={i} className="hub-link-row">
          <input value={r.url} onChange={(e) => set(i, "url", e.target.value)} placeholder={HUB_LINK_COPY.urlPlaceholder} aria-label={`${HUB_LINK_COPY.urlLabel} ${i + 1}`} />
          <input value={r.title} onChange={(e) => set(i, "title", e.target.value)} placeholder={HUB_LINK_COPY.titlePlaceholder} aria-label={`${HUB_LINK_COPY.titleLabel} ${i + 1}`} />
          <input value={r.rel} onChange={(e) => set(i, "rel", e.target.value)} placeholder={HUB_LINK_COPY.relPlaceholder} aria-label={`${HUB_LINK_COPY.relLabel} ${i + 1}`} list="hub-link-rels" />
          <button type="button" className="ghost icon-button" aria-label={HUB_LINK_COPY.remove(r.title || r.url || String(i + 1))} onClick={() => onChange(rows.filter((_, j) => j !== i))}><HubIcon name="close" size={12} /></button>
        </div>
      ))}
      {error && <span className="hub-error" role="alert">{error}</span>}
      <button type="button" className="ghost small-button hub-link-add" onClick={() => onChange([...rows, { url: "", title: "", rel: "" }])}><HubIcon name="plus" size={11} /> {HUB_LINK_COPY.addLink}</button>
    </fieldset>
  );
}
