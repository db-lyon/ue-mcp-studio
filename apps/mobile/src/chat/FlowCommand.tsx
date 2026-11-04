/**
 * The web client's chat/FlowCommand.tsx for the app: what a /flow message
 * opens above the composer, and a flow's card in the transcript. The form's
 * rules are client-core's (launchers.ts) and the shared package's flows.ts.
 * styles.css: .approvals, .approval-card, .approval-head, .flow-names, .flow-card.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import {
  closestNames,
  flowFormFields,
  flowInputsOf,
  flowOptionsScope,
  stepScopedParams,
  flowValue,
  parseFlowArgs,
  type FlowInput,
  type FlowListing,
  type FlowRunRequest,
  type TranscriptEntry,
} from "@ue-mcp-studio/shared";
import { STEP_SCOPED_UNREACHABLE, flowParamsFrom as paramsFrom, flowPrefillValue as prefillValue } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";
import { Banner, Button, Output, font, useStyles, useTheme, type Theme } from "../ui";
import { FieldsForm } from "./Forms";

type Loaded =
  | { kind: "loading" }
  | { kind: "unnamed"; flows: FlowListing[] }
  | { kind: "unknown"; closest: string[] }
  | { kind: "error"; message: string }
  | { kind: "ready"; flow: FlowListing | null; inputs: FlowInput[]; scope: "flat" | "step" };

/**
 * The card a /flow or /action opens above the composer: its title and command
 * over its body, in the approvals region.
 */
export function LauncherCard({ region, title, command, children }: { region: string; title: string; command: string; children: ReactNode }) {
  const s = useStyles(styles);
  return (
    <View style={s.region} accessibilityLabel={region}>
      <View style={s.card} accessibilityLabel={title}>
        <View style={s.head}>
          <Text style={s.title}>{title}</Text>
          <Text style={s.dimSmall}>{command}</Text>
        </View>
        {children}
      </View>
    </View>
  );
}

/** A line of the launcher: .small or .dim.small in a paragraph's margins. */
export function LauncherText({ children, dim, status }: { children: ReactNode; dim?: boolean; status?: boolean }) {
  const s = useStyles(styles);
  return <Text accessibilityLiveRegion={status ? "polite" : undefined} style={[s.p, dim && s.dim]}>{children}</Text>;
}

/** A name the launcher offers in place of the one typed. */
export function NameButton({ name, onPress }: { name: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={name} onPress={onPress} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 10, justifyContent: "center", backgroundColor: pressed ? t.c.panel3 : t.c.panel2, borderWidth: 1, borderColor: pressed ? t.c.accentLine : t.c.lineStrong, borderRadius: t.radius })}>
      <Text style={[font(t, "mono", 400, t.base.size * 0.92, 1.2), { color: t.c.text }]}>{name}</Text>
    </Pressable>
  );
}

/** .row with the launcher's Close at its end. */
export function CloseRow({ onClose }: { onClose: () => void }) {
  const s = useStyles(styles);
  return (
    <View style={s.row}>
      <View style={{ flex: 1 }} />
      <Button title="Close" variant="ghost" onPress={onClose} />
    </View>
  );
}

/** Names to pick from: the flows there are, or the closest to one that is not. */
export function NameRow({ names, closest, onPick }: { names: string[]; closest?: boolean; onPick: (n: string) => void }) {
  const s = useStyles(styles);
  return (
    <View style={[s.row, { flexWrap: "wrap", gap: 6 }]}>
      {closest ? <Text style={s.dimSmall}>Closest:</Text> : null}
      {names.map((n) => <NameButton key={n} name={n} onPress={() => onPick(n)} />)}
    </View>
  );
}

/**
 * What a /flow message opens above the composer: the flow's inputs as a form,
 * defaults filled in and the pairs typed after the name over them. A flow
 * with no inputs runs at once. A name that is no flow shows the closest ones.
 */
export function FlowLauncher({ text, run, onClose }: { text: string; run: (request: FlowRunRequest) => Promise<unknown>; onClose: () => void }) {
  const { api } = useProjectNav();
  const parsed = useMemo(() => parseFlowArgs(text.replace(/^\s*\/flow\b/, "")), [text]);
  const [name, setName] = useState(parsed.name);
  const typed = name === parsed.name ? parsed.values : {};
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (params: Record<string, unknown>, shown?: string) => {
    setSent(true);
    setError(null);
    run({ name, params, ...(shown ? { text: shown } : {}) }).then(onClose, (e: Error) => {
      setSent(false);
      setError(e.message);
    });
  };

  useEffect(() => {
    let live = true;
    setLoaded({ kind: "loading" });
    const listed = api.flows().then((r) => r.flows, () => null);
    if (!name) {
      void listed.then((flows) => live && setLoaded({ kind: "unnamed", flows: flows ?? [] }));
      return () => {
        live = false;
      };
    }
    void Promise.all([listed, api.planFlow(name).then((p) => ({ ok: true as const, p }), (e: Error) => ({ ok: false as const, e }))]).then(([flows, plan]) => {
      if (!live) return;
      const flow = flows?.find((f) => f.name === name) ?? null;
      if (flows && !flow) return setLoaded({ kind: "unknown", closest: closestNames(name, flows.map((f) => f.name)) });
      if (!plan.ok) return setLoaded({ kind: "error", message: plan.e.message });
      const inputs = flowInputsOf(plan.p);
      const scope = flowOptionsScope(plan.p);
      setLoaded({ kind: "ready", flow, inputs, scope });
      // Nothing to ask: it runs as it is.
      if (inputs.length === 0) start(scope === "step" ? {} : Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, flowValue(v, null)])));
    });
    return () => {
      live = false;
    };
  }, [name]);

  let body: ReactNode;
  if (loaded.kind === "loading") body = <LauncherText dim status>Reading the flow</LauncherText>;
  else if (loaded.kind === "unnamed") {
    body = (
      <>
        <LauncherText>Name a flow after /flow.</LauncherText>
        {loaded.flows.length > 0 && <NameRow names={loaded.flows.map((f) => f.name)} onPick={setName} />}
        <CloseRow onClose={onClose} />
      </>
    );
  } else if (loaded.kind === "unknown") {
    body = (
      <>
        <LauncherText>No flow named {name}.</LauncherText>
        {loaded.closest.length > 0 && <NameRow names={loaded.closest} closest onPick={setName} />}
        <CloseRow onClose={onClose} />
      </>
    );
  } else if (loaded.kind === "error") {
    body = (
      <>
        <Banner kind="bad">{loaded.message}</Banner>
        <CloseRow onClose={onClose} />
      </>
    );
  } else if (loaded.inputs.length === 0) {
    body = error ? <><Banner kind="bad">{error}</Banner><CloseRow onClose={onClose} /></> : <LauncherText dim status>Starting</LauncherText>;
  } else {
    const inputs = loaded.inputs;
    const { fields, required } = flowFormFields(inputs);
    const byName = new Map(inputs.map((i) => [i.name, i]));
    const prefill = Object.fromEntries(Object.entries(typed).filter(([k]) => k in fields).map(([k, v]) => [k, prefillValue(v, byName.get(k))]));
    // A step-scoped flow takes each param under the step it is for.
    const scoped = loaded.scope === "step";
    const submit = (params: Record<string, unknown>) => {
      if (!scoped) return start(params);
      const nested = stepScopedParams(inputs, params);
      if (nested) return start(nested);
      setError(STEP_SCOPED_UNREACHABLE);
    };
    body = (
      <>
        {loaded.flow?.description ? <LauncherText>{loaded.flow.description}</LauncherText> : null}
        <FieldsForm
          key={name}
          fields={fields}
          required={required}
          prefill={prefill}
          sent={sent}
          error={error}
          submitLabel="Run"
          declineLabel="Cancel"
          requireFilled
          onSubmit={(content) => submit(paramsFrom(inputs, content, typed))}
          onDecline={onClose}
        />
      </>
    );
  }
  return (
    <LauncherCard region="Run a flow" title={name ? `Run flow ${name}` : "Run a flow"} command="/flow">
      {body}
    </LauncherCard>
  );
}

const STATE_LABEL: Record<Extract<TranscriptEntry, { kind: "flow" }>["state"], string> = {
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  stopped: "Stopped",
};

/** A /flow's card in the transcript: its steps as they run, then its summary or errors. */
export function FlowCard({ entry }: { entry: Extract<TranscriptEntry, { kind: "flow" }> }) {
  const t = useTheme();
  const s = useStyles(styles);
  const tone = entry.state === "failed" ? "bad" : entry.state === "stopped" ? "warn" : undefined;
  const border = tone === "bad" ? t.c.badLine : tone === "warn" ? t.c.warnLine : t.c.line;
  const bg = tone === "bad" ? t.c.badWash : tone === "warn" ? t.c.warnWash : t.c.panel2;
  const stepColor = { done: t.c.ok, failed: t.c.bad } as Record<string, string>;
  return (
    <View accessibilityLabel={`Flow ${entry.name}`} accessibilityLiveRegion="polite" style={[s.flowCard, { borderColor: border, backgroundColor: bg }]}>
      <View style={[s.row, { marginVertical: 0 }]}>
        <Text style={[font(t, "mono", 700, t.base.size * 0.92, 1.4), { color: t.c.text }]}>{entry.name}</Text>
        <Text style={s.dimSmall}>{STATE_LABEL[entry.state]}{entry.duration !== undefined ? ` in ${(entry.duration / 1000).toFixed(1)} s` : ""}</Text>
      </View>
      {entry.steps.length > 0 && (
        <View>
          {entry.steps.map((st, i) => (
            <Text key={st.id} style={[s.small, { marginLeft: 20 + (st.depth ?? 0) * 14, color: stepColor[st.state] ?? t.c.text }, st.state === "running" && { fontFamily: font(t, "sans", 600, 12).fontFamily }, st.state === "skipped" && { opacity: 0.55 }]}>
              {`${i + 1}. `}
              <Text style={font(t, "mono", 400, 11)}>{st.name}</Text>
              {st.state === "skipped" ? <Text style={{ color: t.c.dim }}> skipped</Text> : null}
              {st.error ? ` ${st.error}` : null}
            </Text>
          ))}
        </View>
      )}
      {entry.errors && entry.errors.length > 0 ? (entry.errors.length === 1 ? <Text style={s.small}>{entry.errors[0]}</Text> : <View>{entry.errors.map((e, i) => <Text key={i} style={s.small}>{`• ${e}`}</Text>)}</View>) : null}
      {entry.summary ? <Output maxHeight={258}>{entry.summary}</Output> : null}
    </View>
  );
}

const styles = (t: Theme) => {
  const lh = t.editor ? 1.5 : 1.55;
  return {
    region: { gap: 10, paddingTop: 8, paddingHorizontal: 10 },
    card: { backgroundColor: t.c.panel, borderWidth: 1, borderColor: t.editor ? "transparent" : t.c.line, borderRadius: t.radiusLg, padding: 12, ...(t.shadow ? { boxShadow: "0 20px 40px -24px rgba(0, 0, 0, 0.6)" } : {}) },
    head: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 10 },
    title: { ...font(t, "sans", 700, t.base.size), lineHeight: t.base.lineHeight, color: t.c.text },
    dimSmall: { ...font(t, "sans", 400, 12, lh), color: t.c.dim },
    p: { ...font(t, "sans", 400, 12, lh), color: t.c.text, marginVertical: 12 },
    dim: { color: t.c.dim },
    small: { ...font(t, "sans", 400, 12, lh), color: t.c.text },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, flexWrap: "wrap" as const, marginVertical: 6 },
    flowCard: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, marginBottom: 10, gap: 6 },
  };
};
