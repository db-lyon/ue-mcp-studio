/**
 * The panels an open playtest card shows: Start playtest's options, the
 * draft editor (Edit), and the Assign to subagent loop with its attempts.
 */
import { lhOf } from "./live";
import { useState, type ReactNode } from "react";
import { Pressable, View, Text } from "react-native";
import {
  EDIT_OPS,
  EDIT_PLAYERS,
  EMPTY_ROW,
  loopChangeGroups,
  loopHeadline,
  playersNeeded,
  qaPlural,
  rowOf,
  rowsValid,
  stepsOf,
  type EditRow,
  type RunOptions,
  DEFAULT_RUN,
} from "@ue-mcp-studio/client-core";
import { qaScriptSteps, type QaLoop, type QaRun, type QaScriptStep } from "@ue-mcp-studio/shared";
import { Banner, Check, Input, Pill, SelectArrow, T, bannerText, font, useStyles, useTheme, type Theme } from "../../ui";
import { Disclosure, chooseFrom, SmallButton } from "./parts";
import { StepText } from "./StepText";

const small = (t: Theme) => font(t, "sans", 400, 12, lhOf(t));

export function RunPanel({ run, busy, onStart, onCancel }: { run: QaRun; busy: boolean; onStart: (o: RunOptions) => void; onCancel: () => void }) {
  const t = useTheme();
  const s = useStyles(panelStyles);
  const needed = playersNeeded(run);
  const [o, setO] = useState<RunOptions>({ ...DEFAULT_RUN, players: needed, listen: needed > 1 });
  return (
    <View style={s.options} accessibilityLabel="Start playtest options">
      <Check checked={o.startPie} onChange={(v) => setO({ ...o, startPie: v })} label="Start PIE">
        <T style={[small(t), { color: t.c.muted }]}>Start PIE <Text style={{ color: t.c.dim }}>(off: use the PIE session that is running)</Text></T>
      </Check>
      <View style={s.row}>
        <T style={[small(t), { color: t.c.muted }]}>Players</T>
        <Input
          accessibilityLabel="Players"
          keyboardType="number-pad"
          value={String(o.players)}
          onChangeText={(v) => {
            const players = Math.max(1, Math.min(8, Number(v) || 1));
            setO({ ...o, players, listen: players > 1 ? o.listen : false });
          }}
          style={{ width: 4.5 * 16 }}
        />
      </View>
      <Check checked={o.listen} disabled={o.players < 2} onChange={(v) => setO({ ...o, listen: v })} label="Listen server">
        <T style={[small(t), { color: t.c.muted }]}>Listen server</T>
      </Check>
      <Check checked={o.record} onChange={(v) => setO({ ...o, record: v })} label="Record">
        <T style={[small(t), { color: t.c.muted }]}>Record <Text style={{ color: t.c.dim }}>(so the run can be replayed)</Text></T>
      </Check>
      <View style={s.row}>
        <View style={{ flex: 1 }} />
        <SmallButton title="Cancel" ghost onPress={onCancel} />
        <SmallButton title="Start" primary disabled={busy} onPress={() => onStart(o)} />
      </View>
    </View>
  );
}

/** A <select>: the value in an outlined box with the platform's caret; a tap lists the options. */
export function Select({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; title: string }>; onChange: (v: string) => void }) {
  const t = useTheme();
  const s = useStyles(panelStyles);
  const shown = options.find((o) => o.value === value)?.title ?? value;
  const pick = () => chooseFrom(label, options.map((o) => o.title), (i) => onChange(options[i].value));
  return (
    <Pressable accessibilityRole="combobox" accessibilityLabel={label} accessibilityValue={{ text: shown }} onPress={pick} style={s.select}>
      {/* The browser sets a select's value 4px in, and half a pixel lower than centring its line would. */}
      <T style={{ ...font(t, "sans", 400, 16), color: t.c.text, flex: 1, paddingLeft: 4, position: "relative", top: 0.5 }} numberOfLines={1}>{shown}</T>
      <SelectArrow />
    </Pressable>
  );
}

/** Controls two to a row, the last alone in its half when odd. */
function pairs(items: ReactNode[], s: { pair: object; cell: object }) {
  const rows: ReactNode[] = [];
  for (let i = 0; i < items.length; i += 2)
    rows.push(
      <View key={i} style={s.pair}>
        <View style={s.cell}>{items[i]}</View>
        <View style={s.cell}>{items[i + 1] ?? null}</View>
      </View>,
    );
  return rows;
}

export function DraftEditor({ run, busy, error, onSave, onCancel }: { run: QaRun; busy: boolean; error?: string | null; onSave: (steps: QaScriptStep[], map: string) => void; onCancel: () => void }) {
  const t = useTheme();
  const s = useStyles(panelStyles);
  const [rows, setRows] = useState<EditRow[]>(() => qaScriptSteps(run).map(rowOf));
  const [map, setMap] = useState(run.map ?? "");
  const set = (i: number, patch: Partial<EditRow>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // input.mono: the mono face at 0.92 of the 12 point row, as the web client sizes it.
  const mono = font(t, "mono", 400, 12 * 0.92, lhOf(t));
  return (
    <View style={s.edit} accessibilityLabel="Edit the playtest">
      <View style={s.map}>
        <T style={[small(t), { color: t.c.dim }]}>Level</T>
        <Input accessibilityLabel="Level" value={map} placeholder="/Game/Maps/L_Example" onChangeText={setMap} style={[mono, { width: "100%" }]} />
        <T style={[small(t), { color: t.c.dim }]}>Empty: the level that is open.</T>
      </View>
      {rows.map((r, i) => (
        <View key={i} style={s.editStep}>
          <View style={s.editHead}>
            <T style={{ ...font(t, "mono", 400, t.base.size * 0.92, lhOf(t)), color: t.c.dim, width: t.base.size * 0.92 * 1.6, textAlign: "right" }}>{i + 1}</T>
            <Input
              accessibilityLabel={`Step ${i + 1} instruction`}
              multiline
              value={r.instruction}
              onChangeText={(v) => set(i, { instruction: v.replace(/\r?\n/g, " ") })}
              style={{ flex: 1, minWidth: 0, ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight }}
            />
            <SmallButton title="Remove" label={`Remove step ${i + 1}`} onPress={() => setRows(rows.filter((_, j) => j !== i))} />
          </View>
          {/* Two equal columns, 6 apart, as the web client's grid; a value and the checkbox take a whole row. */}
          <View style={s.grid}>
            {pairs([
              <Select key="player" label={`Step ${i + 1} player`} value={r.player} options={EDIT_PLAYERS.map((p) => ({ value: p, title: p || "any player" }))} onChange={(v) => set(i, { player: v })} />,
              <Select key="judge" label={`Step ${i + 1} judge`} value={r.judge} options={[{ value: "auto", title: "auto" }, { value: "manual", title: "manual" }]} onChange={(v) => set(i, { judge: v as EditRow["judge"] })} />,
            ], s)}
            {r.judge === "auto" ? (
              <>
                <Input accessibilityLabel={`Step ${i + 1} value`} placeholder="Value, e.g. Door.OpenAngle" value={r.value} onChangeText={(v) => set(i, { value: v })} style={mono} />
                {pairs(
                  [
                    <Select key="op" label={`Step ${i + 1} op`} value={r.op} options={EDIT_OPS.map((op) => ({ value: op, title: op }))} onChange={(v) => set(i, { op: v })} />,
                    r.op !== "decreasing" && r.op !== "increasing" ? <Input key="target" accessibilityLabel={`Step ${i + 1} target`} placeholder="target" value={r.target} onChangeText={(v) => set(i, { target: v })} style={mono} /> : null,
                    <Input key="within" accessibilityLabel={`Step ${i + 1} within ms`} placeholder="within ms" value={r.withinMs} onChangeText={(v) => set(i, { withinMs: v })} style={mono} />,
                  ].filter(Boolean),
                  s,
                )}
              </>
            ) : (
              // label.row.toggle in .qa-edit-step: the browser's checkbox margins (4px left, 3px right) and the step row's 6px gap.
              <View style={{ marginVertical: 6, paddingLeft: 4 }}>
                <Check checked={r.personOnly} onChange={(v) => set(i, { personOnly: v })} label="Only a person judges it">
                  <T style={[small(t), { color: t.c.muted, marginLeft: -1 }]}>Only a person judges it</T>
                </Check>
              </View>
            )}
          </View>
        </View>
      ))}
      <View style={s.row}>
        <SmallButton title="Add a step" ghost onPress={() => setRows([...rows, { ...EMPTY_ROW }])} />
        <View style={{ flex: 1 }} />
        <SmallButton title="Cancel" ghost onPress={onCancel} />
        <SmallButton title="Save" primary disabled={busy || !rowsValid(rows)} onPress={() => onSave(stepsOf(rows), map.trim())} />
      </View>
      {error ? (
        <Banner kind="bad" role="alert">
          <T style={[small(t), { color: bannerText(t, "bad") }]}>Not saved. {error}</T>
        </Banner>
      ) : null}
    </View>
  );
}

export function LoopPanel({ loop, busy, onRevert, onThread, showReason = false }: { loop: QaLoop; busy: boolean; onRevert: (attempt?: number) => void; onThread?: (callId: string) => void; showReason?: boolean }) {
  const t = useTheme();
  const s = useStyles(panelStyles);
  const running = loop.state === "running";
  const open = loop.attempts.filter((a) => !a.reverted && a.changes.length > 0);
  return (
    <View style={s.loop} accessibilityLabel="Playtest loop">
      <T style={small(t)}>{loopHeadline(loop)}</T>
      {loop.state === "needs_you" && loop.blocker && (showReason || loop.blocker.evidence.length > 0) ? (
        <View>
          {showReason ? <T style={small(t)}><StepText text={loop.blocker.reason} /></T> : null}
          {loop.blocker.evidence.map((e, i) => (
            <T key={i} style={small(t)}>
              <Text style={{ color: t.c.dim }}>What it saw: </Text>
              <StepText text={e} />
            </T>
          ))}
        </View>
      ) : null}
      {loop.attempts.length > 0 ? (
        <View style={s.attempts}>
          {loop.attempts.map((a) => (
            <View key={a.n} style={[s.attempt, a.reverted && { opacity: 0.65 }]}>
              <View style={[s.row, { marginBottom: onThread || (!running && !a.reverted && a.changes.length > 0) ? 0 : 6 }]}>
                <T style={[small(t), { fontFamily: font(t, "sans", 700, 12).fontFamily }]}>Attempt {a.n}</T>
                <T style={[small(t), { color: t.c.dim }]}>{a.endedAt ? (a.changes.length ? qaPlural(a.changes.length, "change") : "no changes") : "running"}</T>
                {a.reverted ? <Pill>Reverted</Pill> : null}
              </View>
              {onThread || (!running && !a.reverted && a.changes.length > 0) ? (
                <View style={s.attemptActions}>
                  {onThread ? <SmallButton title="See what it did" label={`Open attempt ${a.n}'s thread`} onPress={() => onThread(a.callId)} style={{ flex: 1 }} /> : null}
                  {!running && !a.reverted && a.changes.length > 0 ? <SmallButton title="Undo its changes" label={`Revert attempt ${a.n}`} disabled={busy} onPress={() => onRevert(a.n)} style={{ flex: 1 }} /> : null}
                </View>
              ) : null}
              {a.changes.length > 0 || a.failing.length > 0 ? (
                <Disclosure summary={a.failing.length ? `${qaPlural(a.failing.length, "step")} failed` : "What it changed"}>
                  {a.failing.map((f, i) => (
                    <T key={i} style={[small(t), { paddingLeft: 16 }]}>
                      {"• "}
                      <StepText text={f} />
                    </T>
                  ))}
                  {loopChangeGroups(a.changes).map(({ group, label, items }) => (
                    <View key={group} style={{ marginTop: 2 }}>
                      <T style={[small(t), { color: t.c.dim }]}>{label}:</T>
                      {items.map((c) => (
                        <T key={c.path} style={[font(t, "mono", 400, 12 * 0.92, lhOf(t)), { color: t.c.text, paddingLeft: 16 }]}>
                          {"• "}
                          {c.path} <Text style={{ color: t.c.dim }}>{c.status}</Text>
                        </T>
                      ))}
                    </View>
                  ))}
                </Disclosure>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {!running && open.length > 0 && !loop.reverted ? (
        <View style={s.row}>
          <T style={[small(t), { color: t.c.dim }]}>Undo the changes of every attempt at once.</T>
          <View style={{ flex: 1 }} />
          <SmallButton title="Revert every attempt" disabled={busy} onPress={() => onRevert()} />
        </View>
      ) : null}
    </View>
  );
}

const panelStyles = (t: Theme) => ({
  options: { gap: 6, borderWidth: 1, borderColor: t.c.line, borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10 },
  row: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 10, marginVertical: 6 },
  ghost: { borderColor: t.c.lineStrong, backgroundColor: t.c.panel2 },
  select: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, minHeight: 44, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, backgroundColor: t.c.panel2 },
  edit: { gap: 8 },
  map: { gap: 4, marginBottom: 8, marginRight: 14 },
  editStep: { gap: 4, borderLeftWidth: 2, borderLeftColor: t.c.lineStrong, paddingLeft: 8 },
  editHead: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 6, marginVertical: 6 },
  grid: { gap: 6, marginVertical: 6 },
  pair: { flexDirection: "row" as const, gap: 6 },
  cell: { flex: 1, minWidth: 0 },
  loop: { gap: 6 },
  attempts: { gap: 4 },
  attempt: { borderLeftWidth: 2, borderLeftColor: t.c.lineStrong, paddingVertical: 2, paddingLeft: 10 },
  attemptActions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 6 },
});
