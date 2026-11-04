import { useEffect, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import type { DialogAnswer, EditorDialog } from "@ue-mcp-studio/shared";
import { decider, outcomeLine, readyIn, statusLine, whoLine } from "@ue-mcp-studio/client-core";
import { Banner, baseFont, Check, ContentButton, font, labelFont, Output, useTheme, type Theme } from "./ui";
import { useProjectNav } from "../../../nav";
import { haptic } from "../../../native/haptics";
import { approvalCard, CardsRegion } from "./Approvals";

const small = (t: Theme) => ({ ...baseFont(t), fontSize: 12, lineHeight: 12 * (t.base.lineHeight / t.base.size) });

/** The open editor dialogs of one session, each a card with the dialog's own buttons. */
export function DialogCards({ dialogs, now }: { dialogs: EditorDialog[]; now: number }) {
  if (dialogs.length === 0) return null;
  return (
    <CardsRegion label="Editor dialogs">
      {dialogs.map((d) => <DialogCard key={d.id} dialog={d} now={now} />)}
    </CardsRegion>
  );
}

/** The rows a person can tick: each unsaved asset of a save prompt. */
function itemsOf(d: EditorDialog) {
  return (d.items ?? []).filter((i) => i.cells.some((c) => c.startsWith("/")));
}

/** Every transition so far, oldest first: ol.dialog-steps, numbered outside an 18px indent. */
function Steps({ dialog: d }: { dialog: EditorDialog }) {
  const t = useTheme();
  if (d.steps.length === 0) return null;
  const s = { ...small(t), color: t.c.text };
  return (
    <View accessibilityRole="list" accessibilityLabel="What happened" style={{ marginTop: 2, paddingLeft: 18, gap: 2 }}>
      {d.steps.map((step, i) => (
        <View key={i}>
          <Text style={[s, { position: "absolute", left: -18, width: 18, paddingRight: 4, textAlign: "right" }]}>{`${i + 1}.`}</Text>
          <Text style={s}>
            <Text style={{ ...font(t, "mono", 400, 12 * 0.92), color: t.c.dim }}>{new Date(step.at).toLocaleTimeString()}</Text> {step.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/**
 * One dialog: its title, message and buttons, which call met it, and one line
 * that says who decides right now. A press is sent to ue-mcp, which presses
 * that button in the editor.
 */
export function DialogCard({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const vh = useWindowDimensions().height;
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<Record<number, boolean>>({});
  const rows = itemsOf(d);
  const who = decider(d);
  const wait = readyIn(d, now);

  // A new phase can be answered again.
  useEffect(() => setSent(null), [who, d.held?.button]);

  const send = (label: string, answer: DialogAnswer) => {
    haptic.success();
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
  const actions = { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginVertical: 6 } as const;
  return (
    <View accessibilityRole="none" accessibilityLabel={`Editor dialog: ${d.title}`} style={approvalCard(t)}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Text style={labelFont(t)}>Editor dialog</Text>
        {meta ? <Text style={[small(t), { color: t.c.dim, flexShrink: 1 }]}>{`met by ${meta}`}</Text> : null}
      </View>
      <Text style={{ ...baseFont(t), ...font(t, "sans", 700, 14), lineHeight: 14 * (t.base.lineHeight / t.base.size) }}>{d.title || "(untitled dialog)"}</Text>
      {d.message ? <Output maxHeight={vh * 0.24}>{d.message}</Output> : null}
      {rows.length > 0 ? (
        <View accessibilityLabel="Assets" style={{ gap: 4, maxHeight: vh * 0.2 }}>
          {rows.map((i) => (
            <Check key={i.index} label={i.label} checked={ticks[i.index] ?? i.checked} disabled={who !== "you" || busy} onChange={(v) => setTicks({ ...ticks, [i.index]: v })}>
              <Text style={[small(t), { color: t.c.muted }]}>
                {i.label} <Text style={{ ...font(t, "mono", 400, 12 * 0.92), color: t.c.dim }}>{i.cells.find((c) => c.startsWith("/"))}</Text>
              </Text>
            </Check>
          ))}
        </View>
      ) : null}
      <Text accessibilityRole="text" accessibilityLiveRegion="polite" style={{ ...baseFont(t), ...font(t, "sans", 600, t.base.size), lineHeight: t.base.lineHeight, color: who === "agent" ? t.c.accent : t.c.text }}>
        {statusLine(d, now)}
      </Text>
      {error ? <Banner kind="bad">{error}</Banner> : null}
      {d.held ? (
        <View style={actions}>
          <ContentButton kind="primary" title={`Press ${d.held.button} now`} disabled={busy} onPress={() => send(d.held!.button, { answer: "release" })} />
          {d.buttons.filter((b) => b !== d.held!.button).map((b) => (
            <ContentButton key={b} title={`${b} instead`} disabled={busy} onPress={() => press(b)} />
          ))}
        </View>
      ) : who === "you" ? (
        <View style={actions}>
          {d.buttons.map((b, i) => (
            <ContentButton key={b} kind={i === 0 ? "primary" : "default"} title={b} disabled={busy || wait > 0} onPress={() => press(b)} />
          ))}
          <ContentButton kind="ghost" title="Let the agent decide" disabled={busy || wait > 0} onPress={() => send("delegate", { answer: "delegate" })} />
        </View>
      ) : who === "agent" ? (
        <View style={actions}>
          <Text style={[small(t), { color: t.c.dim }]}>Answer it yourself:</Text>
          {d.buttons.map((b) => <ContentButton key={b} title={b} disabled={busy} onPress={() => press(b)} />)}
        </View>
      ) : null}
      <Steps dialog={d} />
    </View>
  );
}

/** A dialog in the transcript: what it asked, every transition, and how it ended. */
export function DialogLine({ dialog: d }: { dialog: EditorDialog }) {
  const t = useTheme();
  const meta = whoLine(d);
  const ended = outcomeLine(d);
  return (
    <View accessibilityRole="none" style={{ borderLeftWidth: 2, borderLeftColor: t.c.accentLine, paddingVertical: 4, paddingHorizontal: 10, marginVertical: 6 }}>
      <Text style={baseFont(t)}>
        <Text style={labelFont(t)}>Editor dialog</Text> <Text style={font(t, "sans", 700, t.base.size)}>{d.title || "(untitled dialog)"}</Text>
        {meta ? <Text style={[small(t), { color: t.c.dim }]}>{` met by ${meta}`}</Text> : null}
      </Text>
      <Steps dialog={d} />
      {ended ? <Text style={[small(t), { color: t.c.text }]}>{ended}</Text> : null}
    </View>
  );
}

/** The banner line while a dialog holds the editor: the same line the card says. */
export function DialogBannerLine({ dialog: d, now }: { dialog: EditorDialog; now: number }) {
  const t = useTheme();
  return (
    <Banner kind="warn" role="status">
      <Text style={{ ...baseFont(t), color: t.c.warnText }}>
        <Text style={font(t, "sans", 700, t.base.size)}>Editor waiting on a dialog:</Text> {d.title || "(untitled dialog)"}
        <Text style={{ color: t.c.dim }}>{` ${statusLine(d, now)}`}</Text>
      </Text>
    </Banner>
  );
}
