/**
 * A project's arrangements, as a folder holds Live Sets: each with its own
 * tracks, scenes and level, and the clips shared by all of them. Open one,
 * create, rename, duplicate or delete one, or set the map its runs open.
 * Every change goes to the daemon's /hub/arrangements routes and the list is
 * read again from its answer.
 */
import { useEffect, useState } from "react";
import { GOAL_STATUS_LOOK, RUN_OUTCOME_LOOK, SET_COPY, arrangementsOn, hubHash, shortAgo } from "@ue-mcp-studio/client-core";
import type { ArrangementSummary } from "@ue-mcp-studio/shared";
import { ApiError, api } from "../../api";
import { useHub } from "./state";
import { Empty, HubField, HubIcon, HubLink, Placeholder, ScreenHead, StatusMark } from "./parts";
import { Dialog } from "./dialogs";
import "./arrangement.css";

type Ask =
  | { kind: "new" }
  | { kind: "rename"; a: ArrangementSummary }
  | { kind: "level"; a: ArrangementSummary }
  | { kind: "delete"; a: ArrangementSummary };

export function ArrangementsScreen() {
  const hub = useHub();
  const on = arrangementsOn(hub.health);
  const [list, setList] = useState<ArrangementSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.set.arrangements().then((a) => {
      if (!live) return;
      setError(null);
      setList(a.arrangements);
    }, (e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [on, hub.data.version, reads]);

  if (!on) return <div className="hub-screen"><Empty title={SET_COPY.arrangements}>{SET_COPY.notOffered}</Empty></div>;
  const reread = () => setReads((n) => n + 1);
  const open = (id: string) => hub.go({ screen: "arrangement", arrangementId: id });
  const duplicate = async (a: ArrangementSummary) => {
    try {
      const { arrangement } = await api.set.duplicateArrangement(a.id);
      hub.notify(SET_COPY.duplicated(arrangement.title));
      reread();
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  return (
    <div className="hub-screen hub-arrangements">
      <ScreenHead
        title={SET_COPY.arrangements}
        sub={SET_COPY.arrangementsLead}
        actions={<button className="primary" onClick={() => setAsk({ kind: "new" })}><HubIcon name="plus" size={12} /> {SET_COPY.newArrangement}</button>}
      />
      {error && <div className="banner warn small" role="alert">{error}</div>}
      {!list ? <Placeholder /> : (
        <ul className="hub-list hub-arrangement-list">
          {list.map((a) => {
            const look = GOAL_STATUS_LOOK[a.status];
            const route = { screen: "arrangement" as const, arrangementId: a.id };
            return (
              <li key={a.id} className="hub-goal-line">
                <HubLink href={hubHash(route)} onGo={() => open(a.id)} className="hub-row" data-row="" title={SET_COPY.openArrangement(a.title)}>
                  <StatusMark look={look} label={look.label} />
                  <span className="hub-row-main">
                    <span className="hub-row-title">{a.title}</span>
                    <span className="hub-row-meta">
                      <span>{SET_COPY.arrangementCounts(a.tracks, a.scenes)}</span>
                      <span title={a.level ?? undefined}>{a.level ? SET_COPY.levelOf(a.level) : SET_COPY.noLevel}</span>
                      <span>{a.lastRun ? SET_COPY.lastRun(RUN_OUTCOME_LOOK[a.lastRun.outcome].label.toLowerCase(), shortAgo(a.lastRun.at)) : SET_COPY.neverRun}</span>
                    </span>
                  </span>
                </HubLink>
                <span className="hub-row-actions">
                  <button className="ghost small-button" onClick={() => setAsk({ kind: "rename", a })}>{SET_COPY.rename}</button>
                  <button className="ghost small-button" onClick={() => setAsk({ kind: "level", a })}>{SET_COPY.setLevel}</button>
                  <button className="ghost small-button" onClick={() => void duplicate(a)}>{SET_COPY.duplicateArrangement}</button>
                  <button className="ghost icon-button" aria-label={`${SET_COPY.deleteArrangement} ${a.title}`} title={list.length > 1 ? SET_COPY.deleteArrangement : SET_COPY.deleteLast} disabled={list.length <= 1} onClick={() => setAsk({ kind: "delete", a })}><HubIcon name="trash" size={12} /></button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {ask?.kind === "new" && (
        <ArrangementForm title={SET_COPY.newArrangement} submit={SET_COPY.create} withLevel onClose={() => setAsk(null)}
          onSave={async (title, level) => {
            const { arrangement } = await api.set.createArrangement(title, level);
            hub.notify(SET_COPY.created(arrangement.title));
            setAsk(null);
            open(arrangement.id);
          }} />
      )}
      {ask?.kind === "rename" && (
        <ArrangementForm title={SET_COPY.renameTitle(ask.a.title)} submit={SET_COPY.save} name={ask.a.title} onClose={() => setAsk(null)}
          onSave={async (title) => {
            await api.set.updateArrangement(ask.a.id, { title });
            setAsk(null);
            reread();
          }} />
      )}
      {ask?.kind === "level" && (
        <ArrangementForm title={SET_COPY.levelTitle(ask.a.title)} submit={SET_COPY.save} level={ask.a.level ?? ""} levelOnly onClose={() => setAsk(null)}
          onSave={async (_t, level) => {
            await api.set.updateArrangement(ask.a.id, { level: level || null });
            setAsk(null);
            reread();
          }} />
      )}
      {ask?.kind === "delete" && (
        <DeleteArrangement a={ask.a} onClose={() => setAsk(null)}
          onDeleted={() => {
            hub.notify(SET_COPY.deletedArrangement(ask.a.title));
            setAsk(null);
            reread();
          }} />
      )}
    </div>
  );
}

/** New arrangement, Rename and Level: a name, a level, or both, saved through `onSave`; a refusal stays in the dialog. */
function ArrangementForm({ title, submit, name = "", level = "", withLevel = false, levelOnly = false, onClose, onSave }: {
  title: string;
  submit: string;
  name?: string;
  level?: string;
  withLevel?: boolean;
  levelOnly?: boolean;
  onClose: () => void;
  onSave: (title: string, level: string) => Promise<void>;
}) {
  const [t, setT] = useState(name);
  const [l, setL] = useState(level);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => !busy && onClose();
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(t.trim(), l.trim());
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    }
  };
  const ready = levelOnly || t.trim().length > 0;
  return (
    <Dialog label={title} onClose={close} className="hub-arrangement-form">
      <form className="hub-form" onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) void save();
      }}>
        <div className="overlay-head">{title}</div>
        {!levelOnly && (
          <HubField id="arrangement-name" label={SET_COPY.arrangementTitle}>
            {(a) => <input {...a} autoFocus value={t} onChange={(e) => setT(e.target.value)} maxLength={200} />}
          </HubField>
        )}
        {(withLevel || levelOnly) && (
          <HubField id="arrangement-level" label={SET_COPY.levelLabel}>
            {(a) => <input {...a} autoFocus={levelOnly} value={l} onChange={(e) => setL(e.target.value)} placeholder={SET_COPY.levelPlaceholder} spellCheck={false} />}
          </HubField>
        )}
        {(withLevel || levelOnly) && <p className="small dim">{SET_COPY.levelHelp}</p>}
        {error && <div className="banner bad small" role="alert">{error}</div>}
        <div className="hub-form-actions">
          <span className="spacer" />
          <button type="button" className="ghost" disabled={busy} onClick={close}>{SET_COPY.cancel}</button>
          <button type="submit" className="primary" disabled={busy || !ready}>{submit}</button>
        </div>
      </form>
    </Dialog>
  );
}

/** Confirm deleting an arrangement: what goes with it, and that its clips stay. A refusal (its runs are queued) stays in the dialog. */
function DeleteArrangement({ a, onClose, onDeleted }: { a: ArrangementSummary; onClose: () => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const question = SET_COPY.deleteArrangementTitle(a.title);
  const close = () => !busy && onClose();
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.set.deleteArrangement(a.id);
      onDeleted();
    } catch (e) {
      setBusy(false);
      setError((e as Error).message);
    }
  };
  return (
    <Dialog label={question} onClose={close} className="hub-delete">
      <div className="overlay-head">{question}</div>
      <p className="small">{SET_COPY.deleteArrangementKeeps(a.tracks, a.scenes)}</p>
      {error && <div className="banner bad small" role="alert">{error}</div>}
      <div className="hub-form-actions">
        <span className="spacer" />
        <button className="ghost" autoFocus disabled={busy} onClick={close}>{SET_COPY.cancel}</button>
        <button className="danger-button" disabled={busy} onClick={() => void run()}>{SET_COPY.deleteArrangement}</button>
      </div>
    </Dialog>
  );
}
