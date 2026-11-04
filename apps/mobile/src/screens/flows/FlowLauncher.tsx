/**
 * What a /flow message opens above the composer: the flow's inputs as a form,
 * defaults filled in and the pairs typed after the name over them. A flow
 * with no inputs runs at once; a name that is no flow shows the closest ones;
 * no name lists the project's flows to pick from.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { FLOW_STEP_SCOPE_ERROR, flowParamsFrom, prefillValue, type FlowLoaded } from "@ue-mcp-studio/client-core";
import { closestNames, flowFormFields, flowInputsOf, flowOptionsScope, flowValue, parseFlowArgs, stepScopedParams, type FlowRunRequest } from "@ue-mcp-studio/shared";
import { Banner, Button, font, useTheme } from "../../ui";
import { FieldsForm } from "../../ui/FieldsForm";
import { useProjectNav } from "../../nav";
import { cardFrame, smallFont } from "../../ui/type";

/** The .approvals card the launcher and its states sit in. */
export function LauncherCard({ title, children }: { title: string; children: ReactNode }) {
  const t = useTheme();
  return (
    <View testID="flow-launcher" accessibilityRole="summary" accessibilityLabel="Run a flow" style={s.approvals}>
      <View
        accessibilityLabel={title}
        style={[s.card, cardFrame(t)]}
      >
        <View style={s.head}>
          <Text style={[font(t, "sans", 700, t.base.size), { lineHeight: t.base.lineHeight, color: t.c.text }]}>{title}</Text>
          <Text style={[smallFont(t), { color: t.c.dim }]}>/flow</Text>
        </View>
        {children}
      </View>
    </View>
  );
}

/** A flow's name as a button that picks it: `.small-button.mono`. */
function NameButton({ name, onPress }: { name: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Button size="small" label={name} onPress={onPress}>
      <Text style={[t.editor ? font(t, "sans", 400, 12, 1.2) : { ...font(t, "mono", 500, t.base.size, 1.2), letterSpacing: 0.27 }, { color: t.c.text }]}>{name}</Text>
    </Button>
  );
}

export function FlowLauncher({ text, run, onClose }: { text: string; run: (request: FlowRunRequest) => Promise<unknown>; onClose: () => void }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const parsed = useMemo(() => parseFlowArgs(text.replace(/^\s*\/flow\b/, "")), [text]);
  const [name, setName] = useState(parsed.name);
  const typed = name === parsed.name ? parsed.values : {};
  const [loaded, setLoaded] = useState<FlowLoaded>({ kind: "loading" });
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
      return () => void (live = false);
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
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, api]);

  const p = (words: ReactNode, dim = false) => <Text style={[smallFont(t), { marginVertical: 12, color: dim ? t.c.dim : t.c.text }]}>{words}</Text>;
  const close = (
    <View style={s.row}>
      <View style={{ flex: 1 }} />
      <Button title="Close" onPress={onClose} />
    </View>
  );
  const bad = (m: string) => (
    <Banner kind="bad">
      <Text style={[smallFont(t), { color: t.c.badText }]}>{m}</Text>
    </Banner>
  );

  let body: ReactNode;
  if (loaded.kind === "loading") body = <View accessibilityLiveRegion="polite">{p("Reading the flow", true)}</View>;
  else if (loaded.kind === "unnamed") {
    body = (
      <>
        {p("Name a flow after /flow.")}
        {loaded.flows.length > 0 ? <View style={[s.row, s.names]}>{loaded.flows.map((f) => <NameButton key={f.name} name={f.name} onPress={() => setName(f.name)} />)}</View> : null}
        {close}
      </>
    );
  } else if (loaded.kind === "unknown") {
    body = (
      <>
        {p(`No flow named ${name}.`)}
        {loaded.closest.length > 0 ? (
          <View style={[s.row, s.names]}>
            <Text style={[smallFont(t), { color: t.c.dim }]}>Closest:</Text>
            {loaded.closest.map((n) => <NameButton key={n} name={n} onPress={() => setName(n)} />)}
          </View>
        ) : null}
        {close}
      </>
    );
  } else if (loaded.kind === "error") {
    body = (
      <>
        {bad(loaded.message)}
        {close}
      </>
    );
  } else if (loaded.inputs.length === 0) {
    body = error ? (
      <>
        {bad(error)}
        {close}
      </>
    ) : (
      <View accessibilityLiveRegion="polite">{p("Starting", true)}</View>
    );
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
      setError(FLOW_STEP_SCOPE_ERROR);
    };
    body = (
      <>
        {loaded.flow?.description ? p(loaded.flow.description) : null}
        <FieldsForm key={name} topMargin={loaded.flow?.description ? 0 : 6} fields={fields} required={required} prefill={prefill} sent={sent} error={error} submitLabel="Run" declineLabel="Cancel" requireFilled onSubmit={(content) => submit(flowParamsFrom(inputs, content, typed))} onDecline={onClose} />
      </>
    );
  }
  return <LauncherCard title={name ? `Run flow ${name}` : "Run a flow"}>{body}</LauncherCard>;
}

const s = StyleSheet.create({
  approvals: { flexDirection: "column", gap: 10, paddingTop: 8, paddingHorizontal: 10 },
  card: { padding: 12, borderWidth: 1 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 10 },
  // Block margins collapse on the web: a row keeps 6 below and none above, under a paragraph's 12.
  row: { flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 6 },
  names: { gap: 6 },
});
