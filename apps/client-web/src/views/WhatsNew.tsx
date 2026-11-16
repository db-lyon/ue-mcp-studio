import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { NOTHING_NEW, WHATS_NEW_AVAILABLE, WHATS_NEW_NO_NOTES, WHATS_NEW_PAGE, WHATS_NEW_TITLE, WHATS_NEW_UNAVAILABLE, componentRange, entryDate, moreLine, readWhatsNewWith, shownComponents, whatsNewError } from "@ue-mcp-studio/client-core";
import type { WhatsNew, WhatsNewComponent } from "@ue-mcp-studio/shared";

const openLink = (url: string) => void window.open(url, "_blank", "noopener");

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: "same-origin" }).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}

/**
 * Release notes render without raw HTML (react-markdown drops it) and with its
 * URL filter. Links open outside Studio; images show as a link to the picture,
 * so a release body never loads anything into the page by itself.
 */
const NOTE_COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} onClick={(e) => { e.preventDefault(); if (href) openLink(href); }}>{children}</a>
  ),
  img: ({ src, alt }) => (src ? <a href={String(src)} onClick={(e) => { e.preventDefault(); openLink(String(src)); }}>{alt || "Image"}</a> : <>{alt}</>),
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
};
const NOTE_PLUGINS = [remarkGfm];

function Part({ c, open, retry, retrying }: { c: WhatsNewComponent; open: boolean; retry: () => void; retrying: boolean }) {
  return (
    <details className="whats-new-part" open={open}>
      <summary>
        <strong>{c.name}</strong> <span className="dim small">{componentRange(c)}</span>
      </summary>
      {c.error ? (
        <div className="banner bad small whats-new-error" role="alert">
          <div>{whatsNewError(c)}</div>
          <div className="row">
            <button disabled={retrying} onClick={retry}>{retrying ? "Retrying" : "Retry"}</button>
            {c.releasesUrl && <a href={c.releasesUrl} onClick={(e) => { e.preventDefault(); openLink(c.releasesUrl); }}>{WHATS_NEW_PAGE}</a>}
          </div>
        </div>
      ) : (
        <>
          {c.entries.map((e) => (
            <div key={e.version} className="whats-new-entry">
              <div className="row whats-new-version">
                <h3>{e.version}</h3>
                {e.available && <span className="pill warn">{WHATS_NEW_AVAILABLE}</span>}
                {entryDate(e.publishedAt) && <span className="dim small">{entryDate(e.publishedAt)}</span>}
                <span className="spacer" />
                {e.url && <a className="small" href={e.url} onClick={(ev) => { ev.preventDefault(); openLink(e.url); }}>{WHATS_NEW_PAGE}</a>}
              </div>
              {e.body ? (
                <div className="md whats-new-notes">
                  <Markdown remarkPlugins={NOTE_PLUGINS} components={NOTE_COMPONENTS}>{e.body}</Markdown>
                </div>
              ) : (
                <p className="dim small">{WHATS_NEW_NO_NOTES}</p>
              )}
            </div>
          ))}
          {c.more > 0 && (
            <p className="dim small">
              <a href={c.releasesUrl} onClick={(e) => { e.preventDefault(); openLink(c.releasesUrl); }}>{moreLine(c.more)}</a>
            </p>
          )}
        </>
      )}
    </details>
  );
}

/** The What's new dialog: an accordion per part with notes, each release's notes under its version. */
export function WhatsNewDialog({ onClose }: { onClose: () => void }) {
  // undefined while the first read runs; null when the agent had no answer.
  const [w, setW] = useState<WhatsNew | null | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  const load = (refresh: boolean) =>
    readWhatsNewWith(get, refresh)
      .then(setW, () => setW(null))
      .finally(() => setRetrying(false));
  useEffect(() => void load(false), []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  const retry = () => {
    setRetrying(true);
    void load(true);
  };
  const parts = shownComponents(w ?? null);

  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div className="overlay-card whats-new" role="dialog" aria-modal="true" aria-label={WHATS_NEW_TITLE} onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          {WHATS_NEW_TITLE}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>Close</button>
        </div>
        {w === undefined && <p className="muted">Loading</p>}
        {w === null && (
          <div className="banner bad small whats-new-error" role="alert">
            <div>{WHATS_NEW_UNAVAILABLE}</div>
            <div className="row">
              <button disabled={retrying} onClick={retry}>{retrying ? "Retrying" : "Retry"}</button>
            </div>
          </div>
        )}
        {w && parts.length === 0 && <p className="muted">{NOTHING_NEW}</p>}
        {parts.map((c) => (
          <Part key={c.part} c={c} open={c === parts[0]} retry={retry} retrying={retrying} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** The card's link that opens the dialog. */
export function WhatsNewButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="ghost whats-new-open" onClick={() => setOpen(true)}>{WHATS_NEW_TITLE}</button>
      {open && <WhatsNewDialog onClose={() => setOpen(false)} />}
    </>
  );
}
