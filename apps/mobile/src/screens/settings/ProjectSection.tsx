/**
 * Project as a paired browser shows it (client-web
 * views/settings/ProjectSection.tsx): whether ue-mcp is ready, with Rebuild
 * where the bridge needs it; the context strategy and ue-mcp.yml read only,
 * since they decide what ue-mcp runs; the MCP clients and the bridge plugin.
 */
import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import type { StatusReport } from "ue-mcp/daemon";
import { notThere, problemCopy, readRebuild, tokenizeYaml, tokens, type SettingsSection } from "@ue-mcp-studio/client-core";
import { CONTEXT_STRATEGIES, CONTEXT_STRATEGY_INFO, type ClientContextStrategy, type StudioConfigFile } from "@ue-mcp-studio/shared";
import { Banner, Button, Card, Dot, Spacer, bannerText, font, labelFont, T, useTheme, type Theme } from "../../ui";
import { CardLabel, Head, Opt, Span, Tag, Txt, useMessage } from "./controls";
import { Details } from "./Details";
import { Message } from "./GeneralSection";
import { ReadOnly } from "./ModelsSection";
import { PathText } from "./NativePanel";
import { useSettingsApi } from "./hooks";

type RebuildState = "idle" | "confirm" | "running";

function rebuildMessage(outcome: ReturnType<typeof readRebuild>, reopened: boolean | null): { ok: boolean; text: string } {
  if (outcome.ok) return { ok: true, text: "The bridge plugin is rebuilt and the editor is open again." };
  const f = outcome.failure!;
  if (f.step === "stop") return { ok: false, text: "The editor did not close, so nothing was built. Save your work and close any open dialogs in the editor, then try again." };
  if (f.step === "build") {
    const after = reopened === false ? "The editor did not open again. Open the project in Unreal to keep working on the previous build." : "The editor opened again on the previous build.";
    return { ok: false, text: `The build failed. ${after} ${f.reason}` };
  }
  if (f.step === "start") return { ok: false, text: "The bridge plugin is rebuilt, but the editor did not open again. Open the project in Unreal." };
  return { ok: false, text: `The rebuild did not finish. ${f.reason}` };
}

export function ProjectSection({ onSection }: { onSection: (s: SettingsSection) => void }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [report, setReport] = useState<StatusReport | null>(null);
  const [context, setContext] = useState<ClientContextStrategy | null>(null);
  const [rebuild, setRebuild] = useState<RebuildState>("idle");
  const msg = useMessage();
  const load = () => {
    api.install().then(setReport, msg.fail);
    api.contextStrategy().then(setContext, (e: Error) => (notThere(e) ? setContext(null) : msg.fail(e)));
  };
  useEffect(load, [api]);
  const runRebuild = async () => {
    setRebuild("running");
    msg.clear();
    try {
      const outcome = readRebuild(await api.editor("rebuild"));
      let reopened: boolean | null = null;
      if (outcome.failure?.step === "build") reopened = await api.editor("start").then((r) => readRebuild(r).ok, () => false);
      const said = rebuildMessage(outcome, reopened);
      if (said.ok) msg.ok(said.text);
      else msg.fail(said.text);
    } catch (e) {
      msg.fail(`The rebuild did not run. ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRebuild("idle");
      load();
    }
  };
  const clients = report?.clients.filter((c) => c.configured) ?? [];
  const p = report?.plugin;
  return (
    <>
      <Head title="Project" lead="ue-mcp for this project's MCP clients, and the editor plugin." />
      <Message msg={msg} />
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Dot kind={report ? (report.ok ? "ok" : "warn") : undefined} />
          <Txt weight={700}>{report ? (report.ok ? "Ready" : "Needs attention") : "Checking"}</Txt>
          {p ? (
            <Txt size={12} tone="muted">
              Bridge {p.installedVersion ?? "?"} {p.deployed ? "installed" : "not installed"}
              {p.enabledInUproject ? ", enabled" : ""}, for UE {report?.project.engine ?? "?"}.
            </Txt>
          ) : null}
          <Spacer />
          <Button title="Check again" onPress={load} />
          <Button title="Open project folder" onPress={() => undefined} />
        </View>
        {report?.problems.map((pr) => {
          const copy = problemCopy(pr, report);
          return (
            <View key={pr.code} style={{ borderLeftWidth: 2, borderLeftColor: t.c.warn, paddingVertical: 2, paddingHorizontal: 12, marginVertical: 10 }}>
              <Txt weight={700}>{copy.title}</Txt>
              {copy.detail ? <Txt tone="muted" style={{ marginTop: 2 }}>{copy.detail}</Txt> : null}
              {copy.action === "rebuild" && rebuild === "idle" ? (
                <View style={{ flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                  <Button variant="primary" title="Rebuild" onPress={() => setRebuild("confirm")} />
                </View>
              ) : null}
              {copy.action === "rebuild" && rebuild === "confirm" ? (
                <Banner kind="warn" role="alert">
                  <Txt size={12} style={{ color: bannerText(t, "warn") }}>
                    Rebuild closes the editor, builds the project&apos;s C++ including the bridge plugin, and opens the editor again. It can take a few minutes. Unsaved changes get the editor&apos;s save prompt before it closes.
                  </Txt>
                  <View style={{ flexDirection: "row", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                    <Button variant="primary" title="Close the editor and rebuild" onPress={() => void runRebuild()} />
                    <Button variant="ghost" title="Cancel" onPress={() => setRebuild("idle")} />
                  </View>
                </Banner>
              ) : null}
              {copy.action === "rebuild" && rebuild === "running" ? (
                <Banner kind="ok" role="status">
                  <Txt size={12}>Rebuilding. The editor closes, the project&apos;s C++ builds, then the editor opens again.</Txt>
                </Banner>
              ) : null}
              {copy.action === "updates" ? (
                <View style={{ flexDirection: "row", gap: 8, marginTop: 14 }}>
                  <Button title="Open Updates" onPress={() => onSection("general")} />
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>

      <Card>
        <CardLabel>Context strategy</CardLabel>
        <Txt size={12} tone="muted" style={{ marginBottom: 12 }}>
          What MCP clients load at session start. Studio&apos;s agent reads it each turn.
        </Txt>
        {context ? (
          <>
            {context.envOverride ? (
              <Banner kind="warn">
                <Txt size={12} style={{ color: bannerText(t, "warn") }}>
                  <Span mono size={12 * 0.92}>UE_MCP_CONTEXT_STRATEGY={context.envOverride}</Span> overrides this. A choice here applies once it is unset.
                </Txt>
              </Banner>
            ) : null}
            <ReadOnly>
              {/* The list's 8px top margin collapses into the note's 8px bottom one, as in the page's fieldset. */}
              <View style={{ gap: 8 }}>
                {CONTEXT_STRATEGIES.map((s) => (
                  <Opt
                    key={s}
                    label={CONTEXT_STRATEGY_INFO[s].name}
                    on={context.strategy === s}
                    disabled
                    onPick={() => undefined}
                    title={
                      <>
                        {CONTEXT_STRATEGY_INFO[s].name}
                        {context.seeds[s] !== undefined ? <> <Tag>~{tokens(context.seeds[s])} tokens</Tag></> : null}
                        {context.envOverride === s ? <> <Tag kind="warn">in effect, from environment</Tag></> : null}
                        {context.envOverride && context.envOverride !== s && context.strategy === s ? <> <Tag>saved, not in effect</Tag></> : null}
                      </>
                    }
                    desc={`\n${CONTEXT_STRATEGY_INFO[s].sees} ${CONTEXT_STRATEGY_INFO[s].discovery}`}
                  />
                ))}
              </View>
            </ReadOnly>
            <Txt size={12} tone="dim" style={{ marginTop: 8, marginBottom: 12 }}>
              {clients.length ? `Used by ${clients.map((c) => c.name).join(" and ")}. ` : "No other MCP client configured. "}
              Studio&apos;s agent switches at its next turn, other clients at their next session.{context.fromFile ? "" : " Default: Micro."} Token counts measured by ue-mcp.
            </Txt>
          </>
        ) : null}
      </Card>

      <Card>
        <CardLabel>MCP clients</CardLabel>
        {clients.length === 0 ? <Txt size={12} tone="dim" style={{ marginBottom: 12 }}>None configured.</Txt> : null}
        <Txt size={12} tone="dim" style={{ marginBottom: 12 }}>
          Change these from Studio in the editor. It runs ue-mcp init.
        </Txt>
        {clients.map((c) => (
          <View key={c.id} style={{ flexDirection: "row", gap: 14, alignItems: "flex-start", paddingVertical: 11, borderTopWidth: 1, borderTopColor: t.c.line }}>
            <Dot kind="ok" style={{ marginTop: 6 }} />
            <Txt weight={500} style={{ flex: 1 }}>
              <Span weight={700}>{c.name}</Span> <Span size={12} tone="muted">{c.pinned ? `ue-mcp@${c.pinned}` : "ue-mcp@latest"}</Span>
            </Txt>
          </View>
        ))}
      </Card>

      {p ? (
        <Card>
          <CardLabel>Bridge plugin</CardLabel>
          {(
            [
              ["Installed", p.deployed ? `${p.installedVersion ?? "?"} (${p.installKind ?? "unknown"})` : "no"],
              ["Package", p.packagedVersion ?? "?"],
              ["Enabled", p.enabledInUproject ? "yes" : "no"],
              ["Location", p.pluginDir ?? "-"],
              ["Engine", report!.project.engine ?? "?"],
              ["C++ toolchain", report!.toolchain.present ? report!.toolchain.name : "none"],
              ["Node.js", report!.node.version],
            ] as const
          ).map(([k, v]) => (
            <View key={k}>
              <DT>{k}</DT>
              {k === "Location" && p.pluginDir ? (
                <View style={{ marginBottom: 8 }}>
                  <PathText p={p.pluginDir} />
                </View>
              ) : (
                <Txt style={{ marginBottom: 8 }}>{v}</Txt>
              )}
            </View>
          ))}
        </Card>
      ) : null}

      {/* .advanced: 12px more above it. */}
      <View accessibilityLabel="Advanced" style={{ marginTop: 12 }}>
      <Card>
        {/* The Advanced card's summary is a 44px flex row: no disclosure triangle, its line centred. */}
        <Details label="Advanced: ue-mcp.yml" marker={false} summary={<Txt size={12} tone="muted">Advanced: ue-mcp.yml</Txt>} summaryStyle={{ marginVertical: -10, alignItems: "center" }} testID="advanced">
          <ReadOnly>
            <ConfigView />
          </ReadOnly>
        </Details>
      </Card>
      </View>
    </>
  );
}

/** .grid dt: a field's name, mono caps on ue-mcp, the editor's sans in its themes. */
export function DT({ children }: { children: string }) {
  const t = useTheme();
  return <T style={t.editor ? [font(t, "sans", 400, 12, 1.6), { color: t.c.dim }] : [font(t, "mono", 500, 11, 1.6), { color: t.c.dim, textTransform: "uppercase", letterSpacing: 0.88 }]}>{children}</T>;
}

/** The YAML key colour: the text on ue-mcp and editor orange, the light accent on the editor theme. */
const synKey = (t: Theme): string => (t.name === "editor" ? t.c.accentHi : t.c.text);

/** ue-mcp.yml, highlighted, read only: Revert and Save are the computer's. */
function ConfigView() {
  const api = useSettingsApi();
  const t = useTheme();
  const [file, setFile] = useState<StudioConfigFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.config().then(setFile, (e: Error) => setError(e.message));
  }, [api]);
  const parts = useMemo(() => (file ? tokenizeYaml(file.text) : []), [file]);
  if (!file)
    return error ? (
      <Banner kind="bad">
        <Txt style={{ color: bannerText(t, "bad") }}>{error}</Txt>
      </Banner>
    ) : (
      <Txt tone="muted">Loading</Txt>
    );
  const color: Record<string, string> = { key: synKey(t), string: t.c.ok, number: t.c.warn, bool: t.c.warn, null: t.c.warn, anchor: t.c.bad, tag: t.c.bad, comment: t.c.dim, dash: t.c.muted, punct: t.c.muted, doc: t.c.muted };
  return (
    <Card>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", marginVertical: 6 }}>
        <T style={labelFont(t)}>Project config</T>
        <Txt size={12} tone="muted" mono>
          {file.path.split(/[\\/]/).pop()}
        </Txt>
        <Spacer />
        {/* .row-actions: at the row's end, and at the end of the next line when they wrap. */}
        <View style={{ flexDirection: "row", gap: 8, marginLeft: "auto" }}>
          <Button title="Revert" disabled />
          <Button title="Save" disabled />
        </View>
      </View>
      <View style={{ backgroundColor: t.c.codeBg, borderRadius: t.radius, borderWidth: 1, borderColor: t.c.lineStrong, padding: 12, minHeight: 360, maxHeight: 360, overflow: "hidden" }}>
        <T style={[font(t, "mono", 400, 12, 1.6), { color: t.c.codeText }]}>
          {parts.map((p, i) => (p.type ? <Text key={i} style={{ color: color[p.type] }}>{p.text}</Text> : p.text))}
        </T>
      </View>
    </Card>
  );
}

