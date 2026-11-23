/**
 * The inbox: everything that waits for a person, verdicts first and oldest
 * first within a kind. A verdict settles where it is, with Pass, Fail (and a
 * note) or Skip, from the buttons or from p, f and s; the row leaves at once
 * and comes back if the daemon refuses it. Everything else links to where it
 * is dealt with.
 */
import { useMemo, useRef, useState } from "react";
import type { InboxItem, QaVerdict } from "@ue-mcp-studio/shared";
import { GOAL_STATUS_LOOK, HUB_COPY, INBOX_KIND_LABEL, hubHash, inboxTarget, playingRuns, settlesInline, shortAgo, sortInbox } from "@ue-mcp-studio/client-core";
import { api } from "../../api";
import { FailNote } from "../../chat/Qa";
import { useCursor, useHub } from "./state";
import { Empty, HubIcon, HubLink, Kbd, ScreenHead, StatusMark } from "./parts";
import { HubViewer, ViewportButton, useHubViewer } from "./live";

export function InboxScreen() {
  const hub = useHub();
  const { o, go } = hub;
  /** Items settled here, hidden until the next read drops them. */
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const [failing, setFailing] = useState<string | null>(null);
  const items = useMemo(() => sortInbox(o.inbox).filter((i) => !gone.has(i.id)), [o.inbox, gone]);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt, move] = useCursor(items.length, list);
  // One Viewport card beside the list: "Running now" while a waiting verdict's run still plays, so the step is judged by watching.
  const runs = useMemo(() => playingRuns(o), [o]);
  const playing = useMemo(() => new Set(runs.map((r) => r.runId)), [runs]);
  const liveItem = items.find((i) => i.kind === "verdict" && i.runId && playing.has(i.runId)) ?? null;
  const viewer = useHubViewer(liveItem ? runs.find((r) => r.runId === liveItem.runId) ?? null : null);

  const settle = async (item: InboxItem, verdict: QaVerdict, note?: string) => {
    if (!settlesInline(item)) return;
    setFailing(null);
    setGone((g) => new Set(g).add(item.id));
    hub.data.patch((ov) => ({ ...ov, inbox: ov.inbox.filter((i) => i.id !== item.id) }));
    try {
      await api.hub.verdict(item.runId!, item.step!, verdict, note);
    } catch (e) {
      setGone((g) => {
        const next = new Set(g);
        next.delete(item.id);
        return next;
      });
      hub.data.patch((ov) => (ov.inbox.some((i) => i.id === item.id) ? ov : { ...ov, inbox: [...ov.inbox, item] }));
      hub.notify(`The verdict was not recorded: ${(e as Error).message}`, "bad");
      hub.data.reload();
    }
  };
  const openCard = async (item: InboxItem) => {
    if (!item.runId) return;
    try {
      const d = await api.hub.run(item.runId);
      if (d.record.sessionId) hub.openChat(d.record.sessionId, item.runId);
      else go({ screen: "run", runId: item.runId });
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };
  const assign = async (item: InboxItem) => {
    if (!item.runId) return;
    try {
      await api.hub.assign(item.runId);
      hub.notify("Assigned to a subagent");
    } catch (e) {
      hub.notify((e as Error).message, "bad");
    }
  };

  hub.onKeys((a) => {
    const cur = items[at];
    if (a.type === "next") move(1);
    else if (a.type === "prev") move(-1);
    else if (a.type === "open" && cur) go(inboxTarget(cur));
    else if (cur && settlesInline(cur) && a.type === "pass") void settle(cur, "pass");
    else if (cur && settlesInline(cur) && a.type === "skip") void settle(cur, "skip");
    else if (cur && settlesInline(cur) && a.type === "fail") setFailing(cur.id);
    else if (cur && a.type === "assign" && (cur.kind === "regression" || cur.kind === "loop_blocked")) void assign(cur);
    else return false;
    return true;
  });

  return (
    <div className="hub-screen hub-inbox">
      <ScreenHead
        title={<>{HUB_COPY.inbox}{items.length > 0 && <span className="hub-title-count">{items.length}</span>}</>}
        sub={items.length > 0 && !hub.narrow ? <span className="hub-keys-hint"><Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>p</Kbd> pass <Kbd>f</Kbd> fail <Kbd>s</Kbd> skip <Kbd>Enter</Kbd> open</span> : undefined}
      />
      <div className="hub-split">
      <div className="hub-split-main">
      {items.length === 0 ? <Empty title={HUB_COPY.inboxEmpty}>{HUB_COPY.inboxEmptyDetail}</Empty> : (
        <div className="hub-inbox-list" ref={list} role="list" aria-label={HUB_COPY.inbox}>
          {items.map((it, i) => {
            const target = inboxTarget(it);
            const goals = it.goalIds.map((id) => o.goals.find((g) => g.goal.id === id)).filter(Boolean);
            return (
              <article key={it.id} className={`hub-inbox-item kind-${it.kind} ${i === at ? "on" : ""}`} data-row="" role="listitem" aria-current={i === at || undefined} onMouseDown={() => setAt(i)}>
                <div className="hub-inbox-top">
                  <span className="hub-inbox-kind">{INBOX_KIND_LABEL[it.kind]}</span>
                  <HubLink className="hub-inbox-title" href={hubHash(target)} onGo={() => go(target)}>{it.title}</HubLink>
                  <span className="spacer" />
                  <span className="dim small" title={new Date(it.at).toLocaleString()}>{shortAgo(it.at)}</span>
                </div>
                {it.instruction && <div className="hub-ask"><span className="hub-ask-label">Check in PIE</span><span>{it.instruction}</span></div>}
                {it.detail && <p className="muted small hub-inbox-detail">{it.detail}</p>}
                <div className="hub-inbox-foot">
                  {goals.map((g) => g && (
                    <HubLink key={g.goal.id} className="hub-goal-chip" href={hubHash({ screen: "goal", goalId: g.goal.id })} onGo={() => go({ screen: "goal", goalId: g.goal.id })}>
                      <StatusMark look={GOAL_STATUS_LOOK[g.status]} size={10} />{g.goal.title}
                    </HubLink>
                  ))}
                  <span className="spacer" />
                  {/* Only beside the run that plays: every waiting verdict would otherwise carry it while any PIE runs. */}
                  {it.kind === "verdict" && it.runId && playing.has(it.runId) && <ViewportButton relevant compact />}
                  {settlesInline(it) ? (
                    <span className="hub-verdict" role="group" aria-label="Verdict">
                      <button className="verdict-pass" onClick={() => void settle(it, "pass")} title="Pass (p)">Pass</button>
                      <button className="verdict-fail" onClick={() => setFailing(failing === it.id ? null : it.id)} aria-expanded={failing === it.id} title="Fail with a note (f)">Fail</button>
                      <button className="ghost" onClick={() => void settle(it, "skip")} title="Skip (s)">Skip</button>
                    </span>
                  ) : it.kind === "loop_blocked" ? (
                    <>
                      <button onClick={() => void openCard(it)}>Open card</button>
                      <button className="ghost" onClick={() => void assign(it)} title="Assign again (a)"><HubIcon name="assign" size={12} /> Assign again</button>
                    </>
                  ) : it.kind === "regression" ? (
                    <button className="ghost" onClick={() => void assign(it)} title="Assign to a subagent (a)"><HubIcon name="assign" size={12} /> Assign</button>
                  ) : null}
                </div>
                {failing === it.id && it.step !== undefined && (
                  <FailNote step={it.step} initial="" onSubmit={(note) => void settle(it, "fail", note)} onCancel={() => setFailing(null)} />
                )}
              </article>
            );
          })}
        </div>
      )}
      </div>
      <aside className="hub-split-side"><HubViewer viewer={viewer} /></aside>
      </div>
    </div>
  );
}
