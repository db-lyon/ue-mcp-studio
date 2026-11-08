/**
 * Agents > the project's agent files (client-web views/settings/NativePanel.tsx)
 * at phone width: the convention picked from a list, whether a connected route
 * reads it, and its instruction files, subagents and skills, read only. Open
 * file shows the file in Studio's file viewer, as the web page does.
 */
import { useContext, useEffect, useState, type ReactNode } from "react";
import { Linking, Pressable, Text, View } from "react-native";
import { INSTRUCTION_FILE, SKILL_DIR, SOURCE_NAME, SUBAGENT_DIR, conventionOrder, fileCount, firstTab, scopeLine, sharedWith, tokens } from "@ue-mcp-studio/client-core";
import { CONVENTION_INFO, EFFORT_NAMES, type Convention, type Effort, type NativeOverview, type NativePreview, type NativeView } from "@ue-mcp-studio/shared";
import { Banner, Card, Dot, Sheet, bannerText, font, fontName, T, useTheme } from "../../ui";
import { CardLabel, Span, Tag, Txt } from "./controls";
import { Details } from "./Details";
import { Chevron } from "./Pickers";
import { useSettingsApi } from "./hooks";
import { FileViewerContext } from "../../chat/FileLink";

/** A path in the mono face, wrapping after its slashes. */
export function PathText({ p, dim }: { p: string; dim?: boolean }) {
  const t = useTheme();
  return <T style={[font(t, "mono", 400, 12, 1.4), { color: dim ? t.c.dim : t.c.text }]}>{p.split(/(?<=[\\/])/).join("​")}</T>;
}

function OpenFile({ path, small, onWidth }: { path: string; small?: boolean; onWidth?: (w: number) => void }) {
  const viewer = useContext(FileViewerContext);
  const t = useTheme();
  // .cfg button.open-file: the sans at 12px, 3px 10px, 44px tall at a finger. Small, it is drawn 30 px tall and takes taps over 44.
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${path}`}
      onPress={() => viewer?.open({ path })}
      onLayout={onWidth ? (e) => onWidth(e.nativeEvent.layout.width) : undefined}
      hitSlop={small ? { top: 7, bottom: 7, left: 4, right: 4 } : undefined}
      style={{ alignSelf: "flex-start", flexShrink: 0, ...(small ? { height: 30 } : { minHeight: 44, minWidth: 44, paddingVertical: 3 }), paddingHorizontal: 10, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, backgroundColor: t.c.panel2, justifyContent: "center" }}
    >
      <T style={[font(t, "sans", 500, 12, 1.4), { color: t.c.text }]}>Open file</T>
    </Pressable>
  );
}

/** Open file sits on the name line when the name, the gap and the button fit the row; otherwise it goes under the description. */
export function openFileInline(nameWidth: number, rowWidth: number, buttonWidth: number, gap = 10): boolean {
  return rowWidth <= 0 || nameWidth + gap + buttonWidth <= rowWidth;
}

/**
 * A subagent's or skill's row on a phone: the name line with a small Open
 * file at its end, then the description and the rest at the row's full
 * width. A name too long to share its line takes it alone, and Open file
 * goes under the description. The name's own width is measured off screen,
 * so where the button sits never changes what is measured.
 */
export function AgentFileRow({ name, path, first, children }: { name: ReactNode; path: string; first: boolean; children: ReactNode }) {
  const t = useTheme();
  const [row, setRow] = useState(0);
  const [nameWidth, setNameWidth] = useState(0);
  const [button, setButton] = useState(0);
  const inline = openFileInline(nameWidth, row, button);
  return (
    <View testID="agent-file-row" onLayout={(e) => setRow(e.nativeEvent.layout.width)} style={{ paddingVertical: 10, gap: 3, borderTopWidth: first ? 0 : 1, borderTopColor: t.c.line }}>
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ position: "absolute", left: 0, top: 0, opacity: 0 }}>
        <View onLayout={(e) => setNameWidth(e.nativeEvent.layout.width)} style={{ alignSelf: "flex-start" }}>
          <Txt>{name}</Txt>
        </View>
      </View>
      <View testID="agent-file-name" style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 30 }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Txt>{name}</Txt>
        </View>
        {inline ? <OpenFile small path={path} onWidth={setButton} /> : null}
      </View>
      {children}
      {inline ? null : (
        <View style={{ marginTop: 5 }}>
          <OpenFile small path={path} onWidth={setButton} />
        </View>
      )}
    </View>
  );
}

export function NativePanel({ overview, onConnect }: { overview: NativeOverview; onConnect: () => void }) {
  const api = useSettingsApi();
  const t = useTheme();
  const ordered = conventionOrder(overview);
  const [tab, setTab] = useState<Convention>(() => firstTab(overview));
  const [choosing, setChoosing] = useState(false);
  const [preview, setPreview] = useState<NativePreview | null>(null);
  const view = overview.conventions.find((c) => c.convention === tab) ?? null;
  useEffect(() => {
    setPreview(null);
    if (view) api.nativePreview(view.convention).then(setPreview, () => setPreview(null));
  }, [api, view?.convention]);
  const optionText = (v: NativeView) => `${CONVENTION_INFO[v.convention].tool} (${fileCount(v)})${v.routes.length ? ", read by a connected route" : ""}`;
  return (
    <>
      {view ? (
        <View style={{ gap: 4, marginTop: 4, marginBottom: 10 }}>
          <Txt size={12} tone="muted">
            Convention
          </Txt>
          <Pressable accessibilityRole="button" accessibilityLabel="Whose files" onPress={() => setChoosing(true)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, paddingVertical: 6, paddingLeft: 14, paddingRight: 44.3 }}>
            {/* A select's line is line-height: normal, the font's own (21px for Jakarta at 16). */}
            <Text numberOfLines={1} style={[font(t, "sans", 400, 16), { color: t.c.text, flex: 1 }]}>
              {optionText(view)}
            </Text>
            <View style={{ position: "absolute", right: 4, top: 0, bottom: 0, justifyContent: "center" }}>
              <Chevron color={t.c.text} />
            </View>
          </Pressable>
          <Sheet open={choosing} title="Convention" onClose={() => setChoosing(false)}>
            {ordered.map((v) => (
              <Pressable key={v.convention} accessibilityRole="radio" accessibilityState={{ checked: v.convention === tab }} onPress={() => (setTab(v.convention), setChoosing(false))} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 8, borderRadius: t.radius, backgroundColor: v.convention === tab ? t.c.accentWash : "transparent" }}>
                <Txt>{optionText(v)}</Txt>
              </Pressable>
            ))}
          </Sheet>
        </View>
      ) : null}
      {view ? <ConventionView view={view} main={overview.main} preview={preview} shared={sharedWith(view, overview)} onPick={setTab} onConnect={onConnect} /> : null}
    </>
  );
}

/** dl.fields: names in a column as wide as the widest, values beside them, 2px between rows. */
/** A bare <code>: the browser's own monospace at the line's size, no box. */
function Code({ children }: { children: ReactNode }) {
  return <Text style={{ fontFamily: fontName("system-mono"), fontWeight: "400" }}>{children}</Text>;
}

/**
 * dl.fields: names in a max-content column, values beside them. Each name's cell also holds every
 * name at no height, so it is exactly as wide as the widest, unrounded, as the grid column is.
 */
function Fields({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <View style={{ marginVertical: 2, gap: 2 }}>
      {rows.map(([k, v]) => (
        <View key={k} style={{ flexDirection: "row", columnGap: 10 }}>
          <View style={{ flexShrink: 0 }}>
            <Txt size={12} tone="dim">
              {k}
            </Txt>
            <View aria-hidden importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ height: 0, overflow: "hidden" }}>
              {rows.map(([n]) => (
                <Txt key={n} size={12}>
                  {n}
                </Txt>
              ))}
            </View>
          </View>
          <Txt size={12} tone="muted" style={{ flex: 1 }}>
            {v}
          </Txt>
        </View>
      ))}
    </View>
  );
}

function ConventionView({ view, main, preview, shared, onPick, onConnect }: { view: NativeView; main: Convention | null; preview: NativePreview | null; shared: ReturnType<typeof sharedWith>; onPick: (c: Convention) => void; onConnect: () => void }) {
  const t = useTheme();
  const info = CONVENTION_INFO[view.convention];
  const inUse = view.routes.length > 0;
  const also = (p: string) => (inUse ? [] : shared.filter((x) => x.paths.includes(p)));
  const AlsoRead = ({ p }: { p: string }) => (
    <>
      {also(p).map((x) => (
        <Txt key={x.convention} size={12} tone="muted">
          Also read under{" "}
          <Txt size={12} tone="accentHi" onPress={() => onPick(x.convention)}>
            {CONVENTION_INFO[x.convention].tool}
          </Txt>
          , by {x.routes.join(", ")}.
        </Txt>
      ))}
    </>
  );
  const scoped = view.instructions.filter((f) => f.scope.kind !== "always").reduce((n, f) => n + f.tokens, 0);
  const later = view.instructions.filter((f) => f.scope.kind !== "always").length;
  const files = preview ? `${preview.files} file${preview.files === 1 ? "" : "s"}${later ? `, ${later} more path-scoped` : ""}` : "";
  return (
    <>
      <Txt size={12} tone="muted" style={{ marginVertical: 12 }}>
        {view.convention === "agents" ? "Custom endpoints read the vendor-neutral files: " : `${info.vendor[0].toUpperCase() + info.vendor.slice(1)} read the files ${info.tool} reads: `}
        {info.reads}{" "}
        <Txt size={12} tone="accentHi" onPress={() => void Linking.openURL(info.docs)}>
          {view.convention === "agents" ? "AGENTS.md documentation" : `${info.tool} documentation`}
        </Txt>
      </Txt>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8, marginTop: 4, marginBottom: 12 }}>
        <Dot kind={inUse ? "ok" : undefined} style={{ top: -1 }} />
        <Txt size={13} style={{ flexShrink: 1 }}>
          {inUse ? `Read by: ${view.routes.join(", ")}.${view.convention === main ? " Main agent." : ""}` : "No connected route reads these."}
          {!inUse && view.convention !== "agents" ? (
            <>
              {" "}
              <Txt size={13} tone="accentHi" onPress={onConnect}>
                Connect one
              </Txt>
            </>
          ) : null}
        </Txt>
      </View>
      {view.notes.map((n) => (
        <Banner key={n} kind="warn">
          <Txt size={12} style={{ color: bannerText(t, "warn") }}>
            {n}
          </Txt>
        </Banner>
      ))}

      <Card>
        <CardLabel>{view.instructions.length ? `Instruction files · ${tokens(view.instructionTokens)} per call` : "Instruction files"}</CardLabel>
        {scoped > 0 ? (
          <Txt size={12} tone="muted" style={{ marginBottom: 12 }}>
            Up to {tokens(view.instructionTokens + scoped)} with path-scoped files.
          </Txt>
        ) : null}
        {view.instructions.length === 0 ? (
          <Txt size={12} tone="dim">
            None found. Usually {INSTRUCTION_FILE[view.convention]} in the project folder.
          </Txt>
        ) : null}
        {view.instructions.map((f, i) => (
          <View key={f.path} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", paddingVertical: 10, borderTopWidth: i ? 1 : 0, borderTopColor: t.c.line }}>
            <Txt tone="dim" style={{ width: 18, paddingTop: 1, fontVariant: ["tabular-nums"] }}>
              {i + 1}
            </Txt>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <PathText p={f.path} />
              <Txt size={12} tone="muted">
                {tokens(f.tokens)} tokens, {scopeLine(f)}
                {f.imports?.length ? `, imports ${f.imports.join(", ")}` : ""}
              </Txt>
              <AlsoRead p={f.path} />
            </View>
            <OpenFile path={f.path} />
          </View>
        ))}
        {view.skipped.map((f) => (
          <View key={f.path} style={{ flexDirection: "row", gap: 10, paddingVertical: 10, paddingLeft: 26, borderTopWidth: 1, borderStyle: "dashed", borderTopColor: t.c.line }}>
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <PathText p={f.path} dim />
              <Txt size={12} tone="muted">
                {f.why}
              </Txt>
            </View>
            <OpenFile path={f.path} />
          </View>
        ))}
        {preview?.text ? (
          <Details summary={<Txt size={12} tone="dim">Preview ({files})</Txt>}>
            {(preview.parts ?? [{ path: "", text: preview.text }]).map((p, i) => (
              <View key={p.path || i} style={{ marginTop: 8 }}>
                {p.path ? <PathText p={p.path} dim /> : null}
                <View style={{ backgroundColor: t.c.codeBg, borderWidth: 1, borderColor: t.c.line, paddingVertical: 10, paddingHorizontal: 12, borderRadius: t.radius, marginTop: 2 }}>
                  <T style={[font(t, "mono", 400, 12, 1.6), { color: t.c.codeText }]}>{p.text}</T>
                </View>
              </View>
            ))}
          </Details>
        ) : null}
      </Card>

      <Card>
        <CardLabel>Subagents</CardLabel>
        {view.subagents.length === 0 ? (
          <Txt size={12} tone="dim">
            {SUBAGENT_DIR[view.convention] ? `None found in ${SUBAGENT_DIR[view.convention]!.replace(/ and /, " or ")}.` : "Custom endpoints have no subagent files."}
          </Txt>
        ) : null}
        {view.subagents.map((a, i) => (
          <AgentFileRow
            key={a.path}
            first={i === 0}
            path={a.path}
            name={
              <>
                <Span weight={700}>{a.name}</Span> <Tag>{SOURCE_NAME[a.source]}</Tag>
              </>
            }
          >
              {a.description ? <Txt size={12} tone="muted">{a.description}</Txt> : null}
              <Fields
                rows={[
                  ["Model", a.model ? <>{a.runs.model} (file says <Code>{a.model}</Code>)</> : a.runs.model],
                  ["Tools", a.tools],
                  ["Turns", a.maxTurns ? `${a.maxTurns} max` : "no limit"],
                  ["Effort", a.effort ? EFFORT_NAMES[a.effort as Effort] ?? a.effort : "not set in the file"],
                  ["Size", `${tokens(a.tokens)} tokens`],
                ]}
              />
              {a.runs.note ? <Txt size={12} tone="warn">{a.runs.note}</Txt> : null}
              {a.problems.map((p) => (
                <Txt key={p} size={12} tone="warn">
                  {p}
                </Txt>
              ))}
              <PathText p={a.path} dim />
          </AgentFileRow>
        ))}
      </Card>

      <Card>
        <CardLabel>Skills</CardLabel>
        {view.skills.length === 0 ? (
          <Txt size={12} tone="dim">
            None found in {SKILL_DIR[view.convention].replace(/ and /, " or ")}.
          </Txt>
        ) : null}
        {view.skills.map((s, i) => (
          <AgentFileRow
            key={s.path}
            first={i === 0}
            path={s.path}
            name={
              <>
                <Span weight={700} mono size={t.base.size * 0.92}>
                  {s.name}
                </Span>{" "}
                <Tag>{s.owner ? `Plugin: ${s.owner}` : SOURCE_NAME[s.source]}</Tag>
              </>
            }
          >
              <Txt size={12} tone="muted">
                {s.description || "No description."} <Span tone="dim">{tokens(s.tokens)} tokens{s.implicit ? "" : ", used only when named"}</Span>
              </Txt>
              <AlsoRead p={s.path} />
              {s.problems.map((p) => (
                <Txt key={p} size={12} tone="warn">
                  {p}
                </Txt>
              ))}
              <PathText p={`${s.path}/SKILL.md`} dim />
          </AgentFileRow>
        ))}
      </Card>
    </>
  );
}
