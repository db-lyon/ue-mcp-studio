/**
 * The smaller pieces of a playtest card, as the web client draws them on a
 * phone: icon buttons, the Fail note, a step's arrange and act line, the
 * captures the agent saw (fetched through the project's tunnel), and the
 * disclosure rows that stand in for <details>.
 */
import { lhOf } from "./live";
import { useEffect, useState, type ReactNode } from "react";
import * as RN from "react-native";
import { Image, Linking, Pressable, View, type StyleProp, type ViewStyle, Text } from "react-native";
import { assetLinkTarget, classifyAssetToken } from "@ue-mcp-studio/shared";
import { qaCapturePath, readAll, setupAsset, stepSetup, type SetupEntry, type Transport } from "@ue-mcp-studio/client-core";
import type { QaStep } from "@ue-mcp-studio/shared";
import { Button, Input, T, font, useStyles, useTheme, type Theme } from "../../ui";
import { Glyph, OptionsGlyph, type GlyphName } from "../../ui/glyphs";
import { AssetToken, ExactAssetLink } from "./StepText";

/** A card action as an icon: its name is the accessible label. */
export function IconButton({ label, glyph, onPress, disabled, expanded, primary, style }: { label: string; glyph: GlyphName | "options"; onPress: () => void; disabled?: boolean; expanded?: boolean; primary?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const s = useStyles(iconStyles);
  const color = disabled ? t.c.dim : primary ? "#fff" : expanded ? t.c.accentHi : t.c.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, expanded }}
      aria-expanded={expanded}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [s.icon, primary && s.primary, expanded && s.expanded, disabled && (primary ? s.primaryOff : s.off), pressed && !disabled && s.pressed, style]}
    >
      {glyph === "options" ? <OptionsGlyph color={color} knob={t.c.panel2} /> : <Glyph name={glyph} color={color} />}
    </Pressable>
  );
}

const iconStyles = (t: Theme) => ({
  icon: { width: 44, height: 44, borderWidth: 1, borderColor: t.c.line, borderRadius: t.radius, backgroundColor: t.c.panel2, alignItems: "center" as const, justifyContent: "center" as const },
  primary: { backgroundColor: t.c.accent, borderColor: t.c.accent },
  primaryOff: { backgroundColor: "transparent", borderColor: t.c.lineStrong },
  expanded: { borderColor: t.c.accentLine },
  off: { borderColor: t.c.disabledLine },
  pressed: { borderColor: t.c.accentLine, backgroundColor: t.c.panel3 },
});

/** A <details>: its summary is a 44 point outlined row; the body shows under it once opened. */
export function Disclosure({ summary, children, initiallyOpen = false, label }: { summary: string; children: ReactNode; initiallyOpen?: boolean; label?: string }) {
  const s = useStyles(disclosureStyles);
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={label ?? summary} accessibilityState={{ expanded: open }} aria-expanded={open} onPress={() => setOpen(!open)} style={s.summary}>
        <T style={s.summaryText}>
          <T style={s.marker}>{open ? "▼" : "▶"} </T>
          {summary}
        </T>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

const disclosureStyles = (t: Theme) => ({
  summary: { alignSelf: "flex-start" as const, minHeight: 44, paddingVertical: 12, paddingHorizontal: 12, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius },
  summaryText: { ...font(t, "sans", 400, 12), lineHeight: 21.6, color: t.c.muted },
  marker: { fontSize: 13.8, color: t.c.text },
});

/** Fail's note: required, Submit sends the fail with it, Cancel records nothing. */
export function FailNote({ step, initial, onSubmit, onCancel, inset = true }: { step: number; initial: string; onSubmit: (note: string) => void; onCancel: () => void; inset?: boolean }) {
  const s = useStyles(noteStyles);
  const [text, setText] = useState(initial);
  const ready = text.trim().length > 0;
  return (
    <View style={[s.note, inset && s.inset]}>
      <T style={s.label} nativeID={`qa-fail-${step}`}>What went wrong?</T>
      <Input accessibilityLabelledBy={`qa-fail-${step}`} accessibilityLabel="What went wrong?" autoFocus multiline numberOfLines={2} value={text} onChangeText={setText} onSubmitEditing={() => ready && onSubmit(text.trim())} style={s.box} />
      <View style={s.row}>
        <SmallButton title="Submit" disabled={!ready} onPress={() => onSubmit(text.trim())} />
        <SmallButton title="Cancel" ghost onPress={onCancel} />
      </View>
    </View>
  );
}

const noteStyles = (t: Theme) => ({
  note: { gap: 4 },
  inset: { marginLeft: t.base.size * 1.6 + 8 },
  label: { ...font(t, "sans", 400, 12, lhOf(t)), color: t.c.muted },
  box: { width: "100%" as const, minHeight: 44 },
  row: { flexDirection: "row" as const, alignItems: "center" as const, flexWrap: "wrap" as const, gap: 10, marginVertical: 6 },
  ghost: { borderColor: t.c.lineStrong, backgroundColor: t.c.panel2 },
});

/** A setup target as a link where it names an asset: an object path exactly, an asset-like name once it resolves. */
function SetupTarget({ target }: { target: string }) {
  const asset = setupAsset(target);
  if (asset.startsWith("/")) {
    const path = assetLinkTarget(asset);
    if (path) return <ExactAssetLink path={path} label={path.slice(path.lastIndexOf(".") + 1)} />;
  }
  if (asset.includes("_") && classifyAssetToken(asset)?.kind === "name") return <AssetToken token={asset} code={false} size={12} />;
  return <>{target}</>;
}

function Entries({ entries }: { entries: SetupEntry[] }) {
  const t = useTheme();
  return (
    <>
      {entries.map((e, i) => (
        <Text key={i}>
          {i > 0 ? ", " : ""}
          {e.verb}
          {e.target ? <>{" "}<SetupTarget target={e.target} /></> : null}
          {e.detail ? <>{" "}<Text style={font(t, "mono", 400, 12 * 0.92)}>{e.detail}</Text></> : null}
        </Text>
      ))}
    </>
  );
}

/** The line under a step that sets itself up or acts; nothing for a step that does neither. */
export function StepSetup({ step }: { step: Pick<QaStep, "arrange" | "act"> }) {
  const t = useTheme();
  const { arrange, act } = stepSetup(step);
  if (!arrange.length && !act.length) return null;
  const text = { ...font(t, "sans", 400, 12, lhOf(t)), color: t.c.dim };
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 12, marginLeft: 12 * 1.6 + 8 }}>
      {arrange.length > 0 ? <T style={text}><Text style={{ color: t.c.muted }}>Arrange: </Text><Entries entries={arrange} /></T> : null}
      {act.length > 0 ? <T style={text}><Text style={{ color: t.c.muted }}>Act: </Text><Entries entries={act} /></T> : null}
    </View>
  );
}

/** Bytes from the computer as a data URI an <Image> can draw. */
async function dataUri(transport: Transport, path: string): Promise<string | null> {
  const reply = await transport("GET", path);
  if (reply.status !== 200) return null;
  const bytes = await readAll(reply);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${reply.headers["content-type"] || "image/png"};base64,${btoa(bin)}`;
}

/** One capture the agent saw: drawn 240 wide with its name under it, or its name and "could not be read". */
export function Capture({ transport, runId, step, n, name, onOpen }: { transport: Transport; runId: string; step: number; n: number; name: string; onOpen?: (uri: string) => void }) {
  const t = useTheme();
  const [uri, setUri] = useState<string | null | undefined>(undefined);
  const [ratio, setRatio] = useState(1);
  useEffect(() => {
    let live = true;
    dataUri(transport, qaCapturePath(runId, step, n)).then((u) => live && setUri(u), () => live && setUri(null));
    return () => void (live = false);
  }, [transport, runId, step, n]);
  const short = name.split(/[\\/]/).pop() ?? name;
  if (uri === null) {
    return (
      <View style={{ minHeight: 44, alignItems: "center", maxWidth: "100%" }}>
        <T style={{ ...font(t, "mono", 400, 12 * 0.92, lhOf(t)), color: t.c.accentHi, paddingVertical: 2 }}>
          {short}
          <Text style={{ color: t.c.dim }}> could not be read</Text>
        </T>
      </View>
    );
  }
  return (
    <Pressable accessibilityRole="imagebutton" accessibilityLabel={short} onPress={() => uri && (onOpen ? onOpen(uri) : void Linking.openURL(uri).catch(() => undefined))} style={{ gap: 4, maxWidth: "100%", minHeight: 44, alignItems: "center" }}>
      {uri ? (
        <Image
          source={{ uri }}
          onLoad={(e) => {
            const src = (e.nativeEvent as { source?: { width: number; height: number } }).source;
            if (src?.width && src.height) setRatio(src.width / src.height);
          }}
          style={{ width: 240, maxWidth: "100%", aspectRatio: ratio, borderWidth: 1, borderColor: t.c.line, borderRadius: t.radius, backgroundColor: t.c.panel2 }}
          accessibilityIgnoresInvertColors
        />
      ) : (
        <View style={{ width: 240, height: 240, borderWidth: 1, borderColor: t.c.line, borderRadius: t.radius, backgroundColor: t.c.panel2 }} />
      )}
      <T style={{ ...font(t, "mono", 400, 12 * 0.92, lhOf(t)), color: t.c.dim }}>{short}</T>
    </Pressable>
  );
}

/** A list to pick one from: the action sheet on iOS, a dialog elsewhere. */
export function chooseFrom(title: string, options: string[], onPick: (index: number) => void) {
  const sheet = (RN as { ActionSheetIOS?: typeof import("react-native").ActionSheetIOS }).ActionSheetIOS;
  if (RN.Platform.OS === "ios" && sheet) sheet.showActionSheetWithOptions({ title, options: [...options, "Cancel"], cancelButtonIndex: options.length }, (i) => i < options.length && onPick(i));
  else RN.Alert.alert(title, undefined, [...options.map((o, i) => ({ text: o, onPress: () => onPick(i) })), { text: "Cancel", style: "cancel" as const }], { cancelable: true });
}

/** `.qa-card button.small-button`: a small button whose words are 11 point with no tracking. */
export function SmallButton({ title, onPress, disabled, label, primary, ghost, danger, picked, style }: { title: string; onPress: () => void; disabled?: boolean; label?: string; primary?: boolean; ghost?: boolean; danger?: boolean; picked?: boolean; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const color = disabled ? t.c.dim : primary ? t.c.onAccent : danger ? t.c.bad : t.c.text;
  const face = t.editor ? font(t, "sans", primary && !disabled ? 600 : 400, 11, 1.2) : font(t, "mono", primary && !disabled ? 600 : 500, 11, 1.2);
  return (
    <Button
      size="small"
      variant={primary ? "primary" : ghost ? "ghost" : "default"}
      label={label ?? title}
      disabled={disabled}
      onPress={onPress}
      style={[ghost && { borderColor: t.c.lineStrong, backgroundColor: t.c.panel2 }, danger && { borderColor: t.c.bad }, picked && { borderColor: t.c.accent }, primary && disabled && { borderColor: t.c.lineStrong }, style]}
    >
      <T style={[face, { color: ghost && !disabled ? t.c.text : color, letterSpacing: 0 }]}>{title}</T>
    </Button>
  );
}
