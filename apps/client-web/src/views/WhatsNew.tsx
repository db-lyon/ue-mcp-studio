import { Children, isValidElement, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { NOTHING_NEW, RELEASE_NOTES_REHYPE, WHATS_NEW_NO_NOTES, WHATS_NEW_PAGE, WHATS_NEW_TITLE, WHATS_NEW_UNAVAILABLE, componentRange, entryDate, moreLine, readWhatsNewWith, shownComponents, whatsNewError } from "@ue-mcp-studio/client-core";
import type { WhatsNew, WhatsNewComponent } from "@ue-mcp-studio/shared";

const openLink = (url: string) => void window.open(url, "_blank", "noopener");

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: "same-origin" }).catch(() => null);
  return res?.ok ? res.json().catch(() => null) : null;
}

function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  return <a className={className} href={href} onClick={(e) => { e.preventDefault(); openLink(href); }}>{children}</a>;
}

/**
 * Release notes go through client-core's sanitiser (RELEASE_NOTES_REHYPE):
 * the safe HTML subset release bodies use, <details> among it, and nothing
 * else. Links open outside Studio; a fold is drawn like the dialog's own.
 */
const NOTE_COMPONENTS: Components = {
  a: ({ href, children }) => (href ? <Link href={href}>{children}</Link> : <>{children}</>),
  img: ({ src, alt }) => (src ? <img className="md-image" src={String(src)} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" /> : <>{alt}</>),
  table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
  // The summary, then everything after it in one indented body, so the fold reads as a level below.
  details: ({ children, open }) => {
    const kids = Children.toArray(children);
    const at = kids.findIndex((k) => isValidElement(k) && (k.props as { node?: { tagName?: string } }).node?.tagName === "summary");
    const summary = at >= 0 ? kids[at] : null;
    const rest = kids.filter((_, i) => i !== at);
    return (
      <details className="whats-new-fold" open={open}>
        {summary}
        <div className="whats-new-fold-body">{rest}</div>
      </details>
    );
  },
  summary: ({ children }) => (
    <summary>
      <span className="whats-new-caret" aria-hidden="true" />
      <span className="whats-new-label">{children}</span>
    </summary>
  ),
};
const NOTE_REMARK = [remarkGfm];
const NOTE_REHYPE = RELEASE_NOTES_REHYPE as unknown as NonNullable<Parameters<typeof Markdown>[0]["rehypePlugins"]>;

export function ReleaseNotes({ text }: { text: string }) {
  return (
    <div className="md whats-new-notes">
      <Markdown remarkPlugins={NOTE_REMARK} remarkRehypeOptions={{ allowDangerousHtml: true }} rehypePlugins={NOTE_REHYPE} components={NOTE_COMPONENTS}>{text}</Markdown>
    </div>
  );
}

function Part({ c, open, retry, retrying }: { c: WhatsNewComponent; open: boolean; retry: () => void; retrying: boolean }) {
  return (
    <details className="whats-new-part" open={open}>
      <summary>
        <span className="whats-new-caret" aria-hidden="true" />
        <span className="whats-new-label">
          <strong>{c.name}</strong> <span className="dim small">{componentRange(c)}</span>
        </span>
      </summary>
      <div className="whats-new-body">
        {c.error ? (
          <div className="banner bad small whats-new-error" role="alert">
            <div>{whatsNewError(c)}</div>
            <div className="row">
              <button disabled={retrying} onClick={retry}>{retrying ? "Retrying" : "Retry"}</button>
              {c.releasesUrl && <Link href={c.releasesUrl}>{WHATS_NEW_PAGE}</Link>}
            </div>
          </div>
        ) : (
          <>
            {c.entries.map((e) => (
              <section key={e.version} className="whats-new-entry">
                <div className="row whats-new-version">
                  <h3>{e.version}</h3>
                  {entryDate(e.publishedAt) && <span className="dim small">{entryDate(e.publishedAt)}</span>}
                  <span className="spacer" />
                  {e.url && <Link className="small" href={e.url}>{WHATS_NEW_PAGE}</Link>}
                </div>
                {e.body ? <ReleaseNotes text={e.body} /> : <p className="dim small whats-new-empty">{WHATS_NEW_NO_NOTES}</p>}
              </section>
            ))}
            {c.more > 0 && (
              <p className="dim small whats-new-more">
                <Link href={c.releasesUrl}>{moreLine(c.more)}</Link>
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/** The What's new dialog: an accordion per part with something newer, each release's notes under its version. */
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
        <div className="whats-new-parts">
          {parts.map((c) => (
            <Part key={c.part} c={c} open={c === parts[0]} retry={retry} retrying={retrying} />
          ))}
        </div>
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
