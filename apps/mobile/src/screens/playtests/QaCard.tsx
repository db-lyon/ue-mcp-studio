/**
 * A playtest as a card, as the web client draws it at phone width: its title
 * and state, the card's own buttons, a path of one bar per step, a line of
 * what happened, and the box that asks for a verdict or says why a loop
 * stopped. Opening it adds the steps: who judges each, its status and
 * evidence, Pass, Fail and Skip on a step that waits, overrides of the agent's
 * verdicts, the loop's attempts, Start playtest's options and the draft
 * editor. The card applies the daemon's events itself (useLiveRun).
 */
import { lhOf } from "./live";
import { Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, View, type ViewStyle, Text } from "react-native";
import {
  QA_VERDICTS,
  STARTING,
  agentEvidenceText,
  cardControls,
  evidenceText,
  expectLine,
  judgeLabel,
  loopPill,
  newerRun,
  offlinePill,
  pathSummary,
  qaResultsPath,
  readText,
  quickRunOptions,
  runPill,
  statusLabel,
  stepTone,
  verdictOf,
  type QaPill as PillState,
  type RunOptions,
  type Transport,
} from "@ue-mcp-studio/client-core";
import { assetLinkTarget, qaAgentMayJudge, qaAgentVerdict, qaIsDraft, qaSummaryOf, qaVerdictForm, type PendingForm, type QaRun, type QaScriptStep, type QaStep, type QaVerdict } from "@ue-mcp-studio/shared";
import { useProjectNav } from "../../nav";
import { Banner, T, bannerText, font, labelFont, useStyles, useTheme, type Theme } from "../../ui";
import { Chevron } from "../../ui/glyphs";
import { RevealContext, useLiveRun, useQaLive, type Measurable } from "./live";
import { Capture, Disclosure, FailNote, IconButton, StepSetup, SmallButton } from "./parts";
import { DraftEditor, LoopPanel, RunPanel } from "./panels";
import { StepPath } from "./StepPath";
import { StepText } from "./StepText";

/** What a card drawn outside a session (the Playtests page) does instead of the session's own calls. */
export interface QaCardActions {
  start?: (o: RunOptions) => Promise<{ run: QaRun }>;
  assign?: () => Promise<{ run: QaRun }>;
  script?: { read: () => Promise<QaRun>; save: (steps: QaScriptStep[], map?: string) => Promise<void>; remove: () => Promise<void> };
}

/** Edit and Delete for a saved script, by its path. */
export function useSavedScript(script: string | undefined, after: () => void = () => undefined): QaCardActions["script"] {
  const { api } = useProjectNav();
  if (!script) return undefined;
  return {
    read: async () => (await api.qaPlaytestScript(script)).run,
    save: async (steps, map) => {
      await api.qaPlaytestSave(script, steps, map);
      after();
    },
    remove: async () => {
      await api.qaPlaytestDelete(script);
      after();
    },
  };
}

function PillView({ pill, label }: { pill: PillState; label?: string }) {
  const t = useTheme();
  const color = pill.tone === "ok" ? t.c.ok : pill.tone === "warn" ? t.c.warn : pill.tone === "bad" ? t.c.bad : pill.tone === "run" ? t.c.text : t.c.muted;
  const line = pill.tone === "ok" ? t.c.okPill : pill.tone === "warn" ? t.c.warnPill : pill.tone === "bad" ? t.c.badPill : t.c.lineStrong;
  const text = t.editor ? font(t, "sans", 400, 11, 1.6) : font(t, "mono", 500, 11, 1.6);
  return (
    <View accessibilityRole="text" accessibilityLabel={label ?? pill.text} style={{ borderRadius: 999, paddingVertical: 1, paddingHorizontal: 9, borderWidth: 1, borderColor: line }}>
      <T style={[text, { color }]} numberOfLines={1}>{pill.text}</T>
    </View>
  );
}

export function QaCard({ run: saved, form: own, onDismiss, actions: outside, meta, extra, slotted = false, offline, testID }: {
  run: QaRun;
  form?: PendingForm;
  onDismiss?: () => void;
  actions?: QaCardActions;
  meta?: ReactNode;
  extra?: ReactNode;
  /** A row of the Playtests page, which draws the legend once over all its rows. */
  slotted?: boolean;
  /** Why the card cannot act now, such as the editor being away: its actions are drawn disabled. */
  offline?: string;
  testID?: string;
}) {
  const t = useTheme();
  const s = useStyles(styles);
  const { api, project } = useProjectNav();
  const live = useQaLive();
  const [run, setRun] = useLiveRun(saved, live);
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<Record<number, QaVerdict>>({});
  const [sending, setSending] = useState<Record<number, QaVerdict>>({});
  const [overriding, setOverriding] = useState<Record<number, QaVerdict>>({});
  const [assigning, setAssigning] = useState(false);
  const [panel, setPanel] = useState<"run" | "edit" | "delete" | null>(null);
  const [editing, setEditing] = useState<QaRun | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** The step the card was last opened on, marked for as long as it is open. */
  const [marked, setMarked] = useState<number | null>(null);
  const [failing, setFailing] = useState<{ index: number; via: "box" | "verdict" | "override" | "edit" } | null>(null);

  const pool = own ? [own, ...(live?.forms ?? [])] : live?.forms ?? [];
  const form = pool.map((f) => ({ f, q: qaVerdictForm(f) })).find((x) => x.q && (x.f === own || x.q.runId === run.runId)) ?? null;
  const asked = new Set(form?.q?.steps ?? []);
  const waiting = run.steps.filter((x) => x.status === "awaiting_verdict");

  const reveal = useContext(RevealContext);
  const cardRef = useRef<Measurable | null>(null);
  const [revealing, setRevealing] = useState(false);
  const openAt = (index: number | null) => {
    setOpen(true);
    setMarked(index);
    if (index === null) setRevealing(true);
  };
  // Opened at its top: brought into view once its body is drawn.
  useEffect(() => {
    if (!revealing) return;
    setRevealing(false);
    reveal(cardRef.current);
  }, [revealing, reveal]);
  // A step that settled is no longer being sent.
  useEffect(() => {
    setSending((cur) => Object.fromEntries(Object.entries(cur).filter(([i]) => run.steps.find((x) => x.index === Number(i))?.status === "awaiting_verdict")));
  }, [run]);

  const take = (r: { run: QaRun }) => setRun((c) => (r.run.runId === c.runId ? newerRun(r.run, c) : r.run));

  const answerForm = (choices: Record<number, QaVerdict>) => {
    if (!form) return;
    const content: Record<string, string> = {};
    for (const [i, v] of Object.entries(choices)) {
      content[`step_${i}`] = v;
      const note = notes[Number(i)]?.trim();
      if (note) content[`step_${i}_note`] = note;
    }
    setSending((cur) => ({ ...cur, ...choices }));
    setPicked({});
    setError(null);
    api.answerForm(form.f.id, { action: "accept", content }).catch((e: Error) => {
      setSending({});
      setError(e.message);
    });
  };

  const decide = (step: QaStep, verdict: QaVerdict, note?: string) => {
    if (note !== undefined) setNotes((cur) => ({ ...cur, [step.index]: note }));
    if (form && asked.has(step.index)) {
      if (note !== undefined) notes[step.index] = note;
      const choices = { ...picked, [step.index]: verdict };
      if ([...asked].every((i) => choices[i] || run.steps.find((x) => x.index === i)?.status !== "awaiting_verdict")) answerForm(choices);
      else setPicked(choices);
      return;
    }
    setSending((cur) => ({ ...cur, [step.index]: verdict }));
    setError(null);
    api.qaVerdict(run.runId, step.index, verdict, note?.trim() || undefined).then(take, (e: Error) => {
      setSending((cur) => {
        const { [step.index]: _gone, ...rest } = cur;
        return rest;
      });
      setError(e.message);
    });
  };

  const override = (step: QaStep, verdict: QaVerdict, note?: string) => {
    setOverriding((cur) => ({ ...cur, [step.index]: verdict }));
    setError(null);
    const clear = () =>
      setOverriding((cur) => {
        const { [step.index]: _gone, ...rest } = cur;
        return rest;
      });
    api.qaVerdict(run.runId, step.index, verdict, note?.trim() || undefined).then(
      (r) => {
        clear();
        setRun((c) => newerRun(r.run, c));
      },
      (e: Error) => {
        clear();
        setError(e.message);
      },
    );
  };

  const assignment = run.assignment;
  const assignSession = run.sessionId ?? live?.sessionId ?? null;
  const scripted = outside ? outside.script : null;
  const savedScript = useSavedScript(!outside && !qaIsDraft(run) && run.script ? run.script : undefined);
  const scriptActions = scripted ?? savedScript;
  const { draft, ended, owned, assigned, needsYouLoop, runnable, stoppable, canAssign, editable } = cardControls(run, {
    outside: outside && { start: !!outside.start, assign: !!outside.assign, script: !!outside.script },
    assignSession,
    open,
  });

  const toggleAssign = () => {
    setAssigning(true);
    setError(null);
    (assigned ? api.qaCancelAssign(run.runId) : outside?.assign && !run.sessionId ? outside.assign() : api.qaAssign(run.runId, run.sessionId ? null : assignSession))
      .then(take, (e: Error) => setError(e.message))
      .finally(() => setAssigning(false));
  };
  const closeLoop = () => {
    setAssigning(true);
    setError(null);
    api.qaCancelAssign(run.runId).then(take, (e: Error) => setError(e.message)).finally(() => setAssigning(false));
  };
  const act = (call: () => Promise<{ run: QaRun } | void>) => {
    setWorking(true);
    setError(null);
    call()
      .then(
        (r) => {
          setPanel(null);
          if (r) take(r);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setWorking(false));
  };
  const start = (o: RunOptions) => act(() => (outside?.start ? outside.start(o) : api.qaRun(run.runId, o)));
  const stop = () => act(() => api.qaStop(run.runId));
  const toggleEdit = () => {
    if (panel === "edit" || !scriptActions) return setPanel(panel === "edit" ? null : "edit");
    setWorking(true);
    setError(null);
    scriptActions
      .read()
      .then(
        (r) => {
          setEditing(r);
          setPanel("edit");
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setWorking(false));
  };

  const sum = run.summary ?? qaSummaryOf(run.steps);
  const partial = Object.keys(picked).length > 0;
  const byAgentCount = run.steps.filter(qaAgentVerdict).length;
  const ask = waiting.find((x) => x.judge === "manual" && !picked[x.index] && !sending[x.index]) ?? null;
  const livePill = runPill(run);
  const pill = livePill && offline ? { tone: "" as const, text: offlinePill(livePill.text) } : livePill;
  const loopP = assignment?.loop ? loopPill(assignment.loop) : null;
  const loopShown = loopP && offline ? { tone: "" as const, text: offlinePill(loopP.text) } : loopP;
  const blocked = scripted ? offline : undefined;
  const optionsOpen = open && panel === "run";
  const off = !!offline;

  const ownActions: ReactNode[] = [];
  if (runnable)
    ownActions.push(
      <View key="start" style={s.start} accessibilityLabel="Start playtest">
        <IconButton primary label={working ? STARTING : ended ? "Run again" : "Start playtest"} disabled={working || off} onPress={() => start(quickRunOptions(run))} glyph="play" />
        <IconButton
          label="Start playtest options"
          disabled={working || off}
          expanded={optionsOpen}
          onPress={() => {
            setPanel(optionsOpen ? null : "run");
            setOpen(true);
          }}
          glyph="options"
        />
      </View>,
    );
  if (stoppable) ownActions.push(<IconButton key="stop" label={`Stop playtest ${run.scriptName}`} disabled={working || off} onPress={stop} glyph="stop" />);
  if (assigned) ownActions.push(<IconButton key="cancel" label={assignment?.loop ? "End the loop" : "Cancel the subagent"} disabled={assigning || off} onPress={toggleAssign} glyph="cancel" />);
  if (canAssign && !assigned) ownActions.push(<IconButton key="assign" label={needsYouLoop ? "Assign again" : "Assign to subagent"} disabled={assigning || off} onPress={toggleAssign} glyph="assign" />);
  if (needsYouLoop) ownActions.push(<IconButton key="end" label="End loop" disabled={assigning || off} onPress={closeLoop} glyph="cancel" />);
  if (editable) {
    ownActions.push(<IconButton key="edit" label={`Edit ${run.scriptName}`} disabled={working || !!blocked} expanded={panel === "edit"} onPress={toggleEdit} glyph="edit" />);
    ownActions.push(<IconButton key="delete" label={`Delete ${run.scriptName}`} disabled={working || !!blocked} onPress={() => setPanel("delete")} glyph="trash" />);
  }
  if (extra) ownActions.push(<Fragment key="extra">{extra}</Fragment>);
  if (onDismiss && ended) ownActions.push(<IconButton key="dismiss" label="Dismiss this run" onPress={onDismiss} glyph="cancel" />);

  const confirmDelete =
    panel === "delete" ? (
      <View style={s.actions} accessibilityLabel="Confirm delete">
        <T style={s.small}>Delete this playtest?</T>
        <SmallButton title="Delete" disabled={working} onPress={() => act(() => (scriptActions ? scriptActions.remove() : api.qaDeleteScript(run.runId)))} danger />
        <SmallButton title="Keep" ghost disabled={working} onPress={() => setPanel(null)} />
      </View>
    ) : null;
  const actionsRow = confirmDelete ?? (ownActions.length > 0 ? <View style={s.actions}>{ownActions}</View> : null);

  const askBox = ask && !open ? ask : null;
  const failInBox = !!askBox && failing?.via === "box" && failing.index === askBox.index;
  const summaryText = run.steps.length ? pathSummary(run, sum) : "No steps read yet";
  const editRun = panel === "edit" ? (scriptActions ? editing : draft ? run : null) : null;
  const tinted = !offline && (run.state === "awaiting_verdict" || needsYouLoop);
  const border: ViewStyle = offline ? { borderColor: t.c.lineStrong } : tinted ? { borderColor: t.c.warn } : {};

  const verdictButton = (step: QaStep, v: { verdict: QaVerdict; label: string }, onPress: () => void, o: { picked?: boolean; disabled?: boolean; label?: string } = {}) => (
    <SmallButton
      key={v.verdict}
      title={v.label}
      label={o.label ?? `${v.label} step ${step.index + 1}`}
      disabled={o.disabled}
      onPress={onPress}
      picked={o.picked}
    />
  );

  return (
    <View ref={cardRef as never} style={[s.card, draft && s.draft, border]} accessibilityLabel={`Playtest ${run.scriptName}`} testID={testID ?? `qa-card-${run.runId}`}>
      <View style={s.head}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} aria-expanded={open} accessibilityLabel={`${open ? "Close" : "Open"} ${run.scriptName}`} onPress={() => (open ? setOpen(false) : openAt(null))} style={s.toggle}>
          <Chevron open={open} color={t.c.text} />
          {draft || run.replayOf ? <T style={[labelFont(t), { flexShrink: 0 }]}>{draft ? "Playtest draft" : "Playtest replay"}</T> : null}
          <T style={s.title} numberOfLines={1}>{run.scriptName}</T>
        </Pressable>
        {run.subagent ? <T style={[s.small, { color: t.c.dim }]} numberOfLines={1}>run by {run.subagent}</T> : null}
        {actionsRow}
        <View style={s.states}>
          {pill ? <PillView pill={pill} /> : null}
          {loopShown ? <PillView pill={loopShown} label={`Loop: ${loopShown.text}`} /> : null}
        </View>
      </View>
      <View style={s.compact}>
        {run.steps.length > 0 ? <StepPath steps={run.steps} onStep={(i) => openAt(i)} ended={ended} /> : null}
        <View style={s.line}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open playtest ${run.scriptName}`} onPress={() => (open ? undefined : openAt(null))} style={s.lineOpen}>
            <T style={[s.small, { color: t.c.dim }]}>
              {offline && (pill || assignment?.loop) ? <Text style={{ color: t.c.text, fontFamily: font(t, "sans", 600, 12).fontFamily }}>Last known: </Text> : null}
              {summaryText}
            </T>
          </Pressable>
          {meta ? <View style={s.meta}>{meta}</View> : null}
        </View>
        {askBox ? (
          <View style={[s.answer, offline && { borderColor: t.c.lineStrong }, failInBox && s.answerFailing]} accessibilityLabel={`Step ${askBox.index + 1} needs you`}>
            <View style={s.answerStep}>
              <T style={[s.answerNum, offline && { color: t.c.muted }]}>{askBox.index + 1}</T>
              <T style={s.answerText}>
                <Text style={{ color: t.c.muted }}>Check in PIE: </Text>
                <StepText text={askBox.instruction} />
              </T>
            </View>
            {failInBox ? (
              <FailNote
                step={askBox.index}
                inset={false}
                initial={notes[askBox.index] ?? ""}
                onCancel={() => setFailing(null)}
                onSubmit={(note) => {
                  setFailing(null);
                  decide(askBox, "fail", note);
                }}
              />
            ) : (
              <View style={s.verdict}>
                {QA_VERDICTS.map((v) => verdictButton(askBox, v, () => (v.verdict === "fail" ? setFailing({ index: askBox.index, via: "box" }) : decide(askBox, v.verdict)), { disabled: off }))}
                {waiting.length > 1 ? <SmallButton title={`+${waiting.length - 1} more`} label={waiting.length === 2 ? "1 more step needs you" : `${waiting.length - 1} more steps need you`} onPress={() => openAt(askBox.index)} /> : null}
              </View>
            )}
          </View>
        ) : null}
        {!askBox && needsYouLoop ? (
          <View style={[s.answer, offline && { borderColor: t.c.lineStrong }]} accessibilityLabel="The loop needs you">
            <T style={[s.answerText, { flex: 1, flexBasis: 200 }]}>{needsYouLoop.blocker?.reason ? <StepText text={needsYouLoop.blocker.reason} /> : "The loop is waiting for you."}</T>
            {!open ? (
              <View style={s.verdict}>
                <SmallButton title="Review" disabled={off} onPress={() => openAt(null)} />
              </View>
            ) : null}
          </View>
        ) : null}
        {error && panel !== "edit" ? (
          <Banner kind="bad" style={{ marginBottom: 0 }}>
            <T style={[s.small, { color: bannerText(t, "bad") }]}>{error}</T>
          </Banner>
        ) : null}
      </View>
      {open ? (
        <View style={s.body}>
          {draft ? (
            <View style={s.scriptPath}>
              <ScriptPath script={run.script} />
            </View>
          ) : null}
          {panel === "run" && runnable ? <RunPanel run={run} busy={working} onStart={start} onCancel={() => setPanel(null)} /> : null}
          {assignment?.loop ? <LoopPanel loop={assignment.loop} busy={working} onRevert={(n) => act(() => api.qaRevertLoop(run.runId, n))} onThread={live?.onThread} showReason={!!askBox} /> : null}
          {assignment && !assignment.loop ? (
            <View style={s.assignment}>
              <T style={[s.small, { color: assigned ? t.c.accent : t.c.dim }]}>
                {assigned ? "A subagent is running this playtest." : assignment.state === "done" ? "A subagent ran this playtest." : assignment.state === "stopped" ? "The subagent was stopped." : "The subagent failed."}
              </T>
              {live?.onThread ? <SmallButton title="Open its thread" ghost onPress={() => live.onThread!(assignment.callId)} /> : null}
            </View>
          ) : null}
          {editRun ? (
            <DraftEditor run={editRun} busy={working} error={error} onSave={(steps, map) => act(() => (scriptActions ? scriptActions.save(steps, map) : api.qaSaveScript(run.runId, steps, map)))} onCancel={() => setPanel(null)} />
          ) : (
            <View style={s.steps}>
              {run.steps.map((step) => {
                const evidence = step.judge === "auto" ? evidenceText(step) : "";
                const verdictable = step.judge === "manual" && (step.status === "awaiting_verdict" || (draft && owned && !run.deleted && !assigned));
                const unchecked = step.judge === "auto" && (draft || (!!run.manual && step.status === "pending"));
                const failBox = failing?.index === step.index && failing.via !== "box" ? failing : null;
                const busy = sending[step.index];
                const byAgent = qaAgentVerdict(step);
                const why = byAgent ? agentEvidenceText(step) : "";
                const tone = stepTone(step);
                const toneColor = tone === "ok" ? t.c.ok : tone === "bad" ? t.c.bad : tone === "warn" ? t.c.warn : tone === "run" ? t.c.accent : null;
                return (
                  <View key={step.index} style={[s.step, toneColor ? { borderLeftColor: toneColor } : null, marked === step.index && s.target]} testID={`qa-step-${step.index}`}>
                    <View style={s.stepRow}>
                      <T style={s.num}>{step.index + 1}</T>
                      <T style={s.instruction}>
                        <StepText text={step.instruction} />
                      </T>
                      <View style={s.tags}>
                        {step.player ? <T style={s.player}>{step.player}</T> : null}
                        <T style={[s.judge, step.judge === "manual" && { color: t.c.text }]}>{judgeLabel(step)}</T>
                        {step.judge === "manual" && !qaAgentMayJudge(step) ? <T style={s.judge}>Person only</T> : null}
                        {byAgent ? <T style={s.badge} accessibilityLabel={`Judged by the agent. ${why.replace(/\n/g, ". ")}`}>Agent</T> : null}
                        {unchecked ? (
                          <T style={[s.small, { color: t.c.dim }]}>Checked when the playtest runs</T>
                        ) : !draft ? (
                          <T style={[s.small, { color: toneColor === t.c.accent ? t.c.accent : toneColor ?? t.c.muted }, tone === "warn" && { fontFamily: font(t, "sans", 600, 12).fontFamily }]} accessibilityLabel={evidence ? `${statusLabel(step, ended)}. ${evidence.replace(/\n/g, ". ")}` : undefined}>
                            {statusLabel(step, ended)}
                          </T>
                        ) : null}
                      </View>
                    </View>
                    <StepSetup step={step} />
                    {step.expect ? <T style={[s.monoInset, s.monoBase, { color: t.c.dim }]}>{expectLine(step)}</T> : null}
                    {step.status === "failed" && step.judge === "auto" && evidence ? (
                      <T style={[s.smallInset, s.small, { color: t.c.badText }]}>{evidence.split("\n").slice(1).join(" ") || evidence}</T>
                    ) : null}
                    {step.note && !verdictable && !byAgent && !failBox ? (
                      <View style={[s.smallInset, s.note]}>
                        <T style={[s.small, { color: t.c.muted, fontStyle: "italic" }]}>{step.note}</T>
                        {step.status === "failed" && step.judge === "manual" ? (
                          <SmallButton title="Edit note" label={`Edit the note on step ${step.index + 1}`} onPress={() => setFailing({ index: step.index, via: "edit" })} style={{ marginLeft: "auto" }} />
                        ) : null}
                      </View>
                    ) : null}
                    {byAgent ? (
                      <View style={s.smallInset}>
                        <Disclosure summary="What the agent saw">
                          {(step.evidence?.note ?? step.note) ? <T style={[s.small, { marginVertical: 4 }]}>{step.evidence?.note ?? step.note}</T> : null}
                          {(step.evidence?.captures ?? []).length > 0 ? (
                            <View style={s.captures}>
                              {step.evidence!.captures!.map((c, n) => (
                                <Capture key={c} transport={project.transport} runId={run.runId} step={step.index} n={n} name={c} />
                              ))}
                            </View>
                          ) : null}
                        </Disclosure>
                      </View>
                    ) : null}
                    {byAgent ? (
                      <View style={[s.smallInset, s.override]}>
                        <T style={[s.small, { color: t.c.dim }]}>Override:</T>
                        {QA_VERDICTS.filter((v) => v.verdict !== verdictOf(step)).map((v) =>
                          verdictButton(step, v, () => (v.verdict === "fail" ? setFailing({ index: step.index, via: "override" }) : override(step, v.verdict)), {
                            picked: overriding[step.index] === v.verdict,
                            disabled: !!overriding[step.index],
                            label: `Override step ${step.index + 1} with ${v.label}`,
                          }),
                        )}
                      </View>
                    ) : null}
                    {verdictable && !failBox && askBox?.index !== step.index ? (
                      <View style={[s.inset, s.verdict]}>
                        {QA_VERDICTS.map((v) =>
                          verdictButton(step, v, () => (v.verdict === "fail" ? setFailing({ index: step.index, via: "verdict" }) : decide(step, v.verdict)), {
                            picked: picked[step.index] === v.verdict || busy === v.verdict,
                            disabled: !!busy || off,
                          }),
                        )}
                      </View>
                    ) : null}
                    {failBox ? (
                      <FailNote
                        step={step.index}
                        initial={failBox.via === "edit" ? step.note ?? "" : notes[step.index] ?? ""}
                        onCancel={() => setFailing(null)}
                        onSubmit={(note) => {
                          setFailing(null);
                          if (failBox.via === "override") override(step, "fail", note);
                          else decide(step, "fail", note);
                        }}
                      />
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}
          {partial && form ? (
            <View style={s.row}>
              <T style={[s.small, { color: t.c.dim, flex: 1 }]}>Pick the rest, or send these now; the others then wait on this card.</T>
              <SmallButton title="Send verdicts" primary onPress={() => answerForm(picked)} />
            </View>
          ) : null}
          {ended ? (
            <View style={s.summary} accessibilityRole="summary">
              <T style={s.small}>
                {run.state === "stopped" ? "Stopped" : "Finished"}: {sum.passed} passed, {sum.failed} failed, {sum.skipped} skipped
                {sum.pending ? `, ${sum.pending} not run` : ""}
                {sum.regressions ? `, ${sum.regressions} regressed` : ""}.
                {byAgentCount > 0 ? ` The agent judged ${byAgentCount === 1 ? "1 step" : `${byAgentCount} steps`}.` : ""}
              </T>
              {run.resultsPath ? <Results transport={project.transport} runId={run.runId} /> : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The script path under a draft's title: a link that opens the script asset; an inline script has none. */
function ScriptPath({ script }: { script: string }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const path = assetLinkTarget(script);
  const text = { ...font(t, "mono", 400, 12), lineHeight: 15.84, letterSpacing: t.editor ? 0 : 0.24, color: t.c.dim };
  if (!path) return <T style={[font(t, "mono", 400, t.base.size * 0.92, lhOf(t)), { color: t.c.dim }]}>{script}</T>;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={script} onPress={() => void api.openAsset(path).catch(() => undefined)} style={{ alignSelf: "flex-start", maxWidth: "100%", backgroundColor: t.c.panel2, borderRadius: 4, paddingVertical: 1, paddingHorizontal: 4, boxShadow: `inset 0 -1px 0 ${t.c.accentLine}` } as ViewStyle}>
      <T style={text}>{script}</T>
    </Pressable>
  );
}

/** results.json: read through the tunnel and shown as text. */
function Results({ transport, runId }: { transport: Transport; runId: string }) {
  const t = useTheme();
  const [text, setText] = useState<string | null>(null);
  const read = () =>
    void transport("GET", qaResultsPath(runId))
      .then(async (r) => setText(await readText(r)))
      .catch(() => setText("results.json could not be read."));
  return (
    <>
      <T style={{ ...font(t, "sans", 400, 12, lhOf(t)), color: t.c.accentHi, paddingVertical: 13, marginVertical: -13 }} accessibilityRole="link" onPress={read}>
        results.json
      </T>
      {text !== null ? (
        <ScrollView horizontal style={{ flexBasis: "100%", maxHeight: 240 }}>
          <T style={{ ...font(t, "mono", 400, 11, 1.5), color: t.c.codeText }} selectable>
            {text}
          </T>
        </ScrollView>
      ) : null}
    </>
  );
}

const styles = (t: Theme) => {
  const inset = t.base.size * 1.6 + 8;
  const small = font(t, "sans", 400, 12, lhOf(t));
  return {
    card: {
      backgroundColor: t.c.panel,
      borderWidth: 1,
      borderColor: t.c.line,
      borderRadius: t.radiusLg,
      paddingVertical: 10,
      paddingHorizontal: 12,
      gap: 6,
      minWidth: 0,
      ...(t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)" } : {}),
    } as ViewStyle,
    draft: { borderStyle: "dashed" as const },
    head: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, rowGap: 6, columnGap: 8, minWidth: 0 },
    toggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, minHeight: 44, width: "100%" as const, minWidth: 0, borderRadius: t.radius },
    title: { ...font(t, "sans", 700, 14, lhOf(t)), color: t.c.text, letterSpacing: t.editor ? 0 : 0.27, flexShrink: 1, minWidth: 0 },
    actions: { flexDirection: "row" as const, alignItems: "center" as const, gap: 4, flexShrink: 0 },
    start: { flexDirection: "row" as const, alignItems: "stretch" as const, gap: 4 },
    states: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, flexShrink: 0, marginLeft: "auto" as const },
    compact: { gap: 4, minWidth: 0 },
    line: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, rowGap: 4, columnGap: 8, minWidth: 0 },
    lineOpen: { flexBasis: "100%" as const, minHeight: 44, justifyContent: "center" as const, alignItems: "flex-start" as const },
    meta: { flexBasis: "100%" as const, minWidth: 0 },
    answer: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, rowGap: 6, columnGap: 10, marginTop: 2, paddingVertical: 6, paddingHorizontal: 8, borderWidth: 1, borderColor: t.c.warn, borderRadius: t.radius, backgroundColor: t.c.panel2 },
    answerFailing: { flexDirection: "column" as const, alignItems: "stretch" as const },
    answerStep: { flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
    answerNum: { ...font(t, "mono", 700, t.base.size * 0.92, lhOf(t)), color: t.c.warn },
    answerText: { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text, flex: 1, minWidth: 0 },
    verdict: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
    body: { gap: 8, minWidth: 0 },
    scriptPath: { marginTop: -4, marginBottom: 10 },
    small,
    mono: font(t, "mono", 400, 12 * 0.92, lhOf(t)),
    monoBase: font(t, "mono", 400, t.base.size * 0.92, lhOf(t)),
    ghost: { borderColor: t.c.lineStrong, backgroundColor: t.c.panel2 },
    assignment: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "baseline" as const, gap: 10 },
    steps: { gap: 2 },
    step: { borderLeftWidth: 2, borderLeftColor: t.c.lineStrong, paddingTop: 5, paddingBottom: 5, paddingLeft: 10, paddingRight: 8, gap: 4 },
    target: { backgroundColor: "rgba(236, 233, 227, 0.07)" },
    stepRow: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "baseline" as const, rowGap: 2, columnGap: 8, minWidth: 0 },
    num: { ...font(t, "mono", 400, t.base.size * 0.92, lhOf(t)), color: t.c.dim, width: t.base.size * 0.92 * 1.6, textAlign: "right" as const },
    instruction: { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.size * 1.75, color: t.c.text, flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0 },
    tags: { flexBasis: "100%" as const, marginLeft: inset, flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "baseline" as const, gap: 8 },
    player: { ...font(t, "sans", 400, 10, lhOf(t)), color: t.c.muted, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: 4, paddingHorizontal: 5, textTransform: "uppercase" as const, letterSpacing: 0.6 },
    judge: { ...font(t, "sans", 600, 10.5, 1.4), color: t.c.muted, letterSpacing: 0.42, textTransform: "uppercase" as const },
    badge: { ...font(t, "sans", 400, 10, lhOf(t)), color: t.c.accent, borderWidth: 1, borderColor: t.c.accentLine, backgroundColor: t.c.accentWash, borderRadius: 999, paddingHorizontal: 7, letterSpacing: 0.6, textTransform: "uppercase" as const },
    inset: { marginLeft: inset },
    monoInset: { marginLeft: t.base.size * 0.92 * 1.6 + 8 },
    smallInset: { marginLeft: 12 * 1.6 + 8 },
    note: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "baseline" as const, rowGap: 4, columnGap: 10 },
    captures: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginVertical: 6 },
    override: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "center" as const, gap: 6 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 10, marginVertical: 6 },
    summary: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "baseline" as const, gap: 10, borderTopWidth: 1, borderTopColor: t.c.line, paddingTop: 8 },
  };
};
