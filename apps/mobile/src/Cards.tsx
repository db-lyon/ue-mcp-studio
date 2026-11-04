/**
 * The cards that wait on the owner inside a session: a call to approve (Allow,
 * Allow for this session, Deny) and an editor dialog (its own buttons, Let the
 * agent decide, or Press now / Override while the agent's choice is held).
 */
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { APPROVAL_KIND, RESTART_OPERATION, approvalTitle, decider, readyIn, statusLine, whoLine, type StudioApi } from "@ue-mcp-studio/client-core";
import type { ApprovalDecision, ApprovalRequest, DialogAnswer, DialogsState, EditorDialog } from "@ue-mcp-studio/shared";
import type { Project } from "./connection";
import { DiffView } from "./ui";
import { s as ui } from "./legacy-ui";
import { colors, mono } from "./theme";

export function CardButton({ title, onPress, primary, ghost, disabled, label }: { title: string; onPress: () => void; primary?: boolean; ghost?: boolean; disabled?: boolean; label?: string }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [c.btn, primary && c.btnPrimary, ghost && c.btnGhost, (pressed || disabled) && { opacity: 0.5 }]}>
      <Text style={[c.btnText, primary && { color: colors.onAccent }]}>{title}</Text>
    </Pressable>
  );
}

export function ApprovalCard({ api, sessionId, approval: a }: { api: StudioApi; sessionId: string; approval: ApprovalRequest }) {
  const [sent, setSent] = useState<ApprovalDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = approvalTitle(a);
  const answer = (decision: ApprovalDecision) => {
    setSent(decision);
    setError(null);
    api.approve(sessionId, a.id, decision).catch((e: Error) => {
      setSent(null);
      setError(e.message);
    });
  };
  return (
    <View style={c.card} accessibilityLabel={title}>
      <View style={c.head}>
        <Text style={c.eyebrow}>{title}</Text>
        {a.subagent ? <Text style={ui.sub}>from subagent {a.subagent}</Text> : null}
      </View>
      {a.tool === "shell" ? (
        <>
          <Text style={c.pre} selectable>{`$ ${a.command ?? ""}`}</Text>
          {a.cwd ? <Text style={ui.sub}>in {a.cwd}</Text> : null}
        </>
      ) : a.tool === "editor_restart" ? (
        <>
          <Text style={c.body}>{RESTART_OPERATION[a.operation ?? "restart"]}. Unsaved work in the editor is lost.</Text>
          {a.reason ? <Text style={ui.sub}>Why: {a.reason}</Text> : null}
        </>
      ) : a.tool === "ue_mcp" ? (
        <>
          <Text style={c.path}>
            {a.call?.category}.{a.call?.method}
          </Text>
          <Text style={c.pre} selectable>
            {JSON.stringify(a.call?.args ?? {}, null, 2)}
          </Text>
          <Text style={ui.sub}>ue-mcp marks this action as one that deletes or overwrites.</Text>
        </>
      ) : (
        <>
          <Text style={c.path} selectable>
            {a.path}
          </Text>
          <DiffView lines={a.diff ?? []} label={`Changes to ${a.path}`} />
        </>
      )}
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <View style={c.actions}>
        <CardButton title="Allow" primary disabled={sent !== null} onPress={() => answer("allow")} />
        <CardButton title="Allow for this session" disabled={sent !== null} label={`Allow ${APPROVAL_KIND[a.tool]} without asking for the rest of this session`} onPress={() => answer("session")} />
        <CardButton title="Deny" ghost disabled={sent !== null} onPress={() => answer("deny")} />
      </View>
    </View>
  );
}

/** The daemon's open editor dialogs, kept current from studio.dialog.changed, with its clock; ticks while one is open. */
export function useDialogs(project: Project, api: StudioApi): { state: DialogsState | null; now: number } {
  const [state, setState] = useState<{ s: DialogsState | null; offset: number }>({ s: null, offset: 0 });
  const [, tick] = useState(0);
  useEffect(() => {
    if (project.live !== "live") return;
    api.dialogs().then((s) => setState({ s, offset: s.now - Date.now() }), () => undefined);
  }, [project.live, api]);
  useEffect(
    () =>
      project.onEvent((e) => {
        if (e.type !== "studio.dialog.changed") return;
        const s = e.data as unknown as DialogsState;
        setState({ s, offset: (s.now ?? Date.now()) - Date.now() });
      }),
    [project],
  );
  const open = (state.s?.dialogs.length ?? 0) > 0;
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [open]);
  return { state: state.s, now: Date.now() + state.offset };
}

/** The rows a person can tick: each unsaved asset of a save prompt. */
const itemsOf = (d: EditorDialog) => (d.items ?? []).filter((i) => i.cells.some((x) => x.startsWith("/")));

export function DialogCard({ api, dialog: d, now }: { api: StudioApi; dialog: EditorDialog; now: number }) {
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<number, boolean>>({});
  const rows = itemsOf(d);
  const who = decider(d);
  const wait = readyIn(d, now);
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
  return (
    <View style={c.card} accessibilityLabel={`Editor dialog: ${d.title}`}>
      <View style={c.head}>
        <Text style={c.eyebrow}>Editor dialog</Text>
        {meta ? <Text style={ui.sub}>met by {meta}</Text> : null}
      </View>
      <Text style={[c.body, { fontWeight: "700" }]}>{d.title || "(untitled dialog)"}</Text>
      {d.message ? <Text style={c.pre}>{d.message}</Text> : null}
      {rows.map((i) => (
        <View key={i.index} style={c.tickRow}>
          <Switch
            accessibilityLabel={i.label}
            value={ticks[i.index] ?? i.checked}
            disabled={who !== "you" || busy}
            onValueChange={(v) => setTicks({ ...ticks, [i.index]: v })}
            trackColor={{ true: colors.accent, false: colors.border }}
            thumbColor={colors.text}
          />
          <View style={{ flex: 1 }}>
            <Text style={c.body}>{i.label}</Text>
            <Text style={[ui.sub, { fontFamily: mono }]} numberOfLines={1}>
              {i.cells.find((x) => x.startsWith("/"))}
            </Text>
          </View>
        </View>
      ))}
      <Text style={[ui.sub, who === "you" && { color: colors.warnText }]} accessibilityLiveRegion="polite">
        {statusLine(d, now)}
      </Text>
      {error ? <Text style={ui.error}>{error}</Text> : null}
      {d.held ? (
        <View style={c.actions}>
          <CardButton title={`Press ${d.held.button} now`} primary disabled={busy} onPress={() => send(d.held!.button, { answer: "release" })} />
          {d.buttons
            .filter((b) => b !== d.held!.button)
            .map((b) => (
              <CardButton key={b} title={`${b} instead`} disabled={busy} onPress={() => press(b)} />
            ))}
        </View>
      ) : who === "you" ? (
        <View style={c.actions}>
          {d.buttons.map((b, i) => (
            <CardButton key={b} title={b} primary={i === 0} disabled={busy || wait > 0} onPress={() => press(b)} />
          ))}
          <CardButton title="Let the agent decide" ghost disabled={busy || wait > 0} onPress={() => send("delegate", { answer: "delegate" })} />
        </View>
      ) : who === "agent" ? (
        <View style={c.actions}>
          <Text style={[ui.sub, { alignSelf: "center" }]}>Answer it yourself:</Text>
          {d.buttons.map((b) => (
            <CardButton key={b} title={b} disabled={busy} onPress={() => press(b)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

export const c = StyleSheet.create({
  card: { backgroundColor: colors.panel, borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 12, marginVertical: 8, gap: 6 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" },
  eyebrow: { color: colors.accent, fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  path: { color: colors.text, fontFamily: mono, fontSize: 13 },
  pre: { color: colors.codeText, fontFamily: mono, fontSize: 12, lineHeight: 18, backgroundColor: colors.code, borderRadius: 6, padding: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  btn: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, minHeight: 40, justifyContent: "center" },
  btnPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  btnGhost: { backgroundColor: "transparent" },
  btnText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  tickRow: { flexDirection: "row", alignItems: "center", gap: 10 },
});
