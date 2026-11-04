/**
 * Models & accounts as a paired browser shows it (client-web
 * views/settings/ModelsSection.tsx under RemoteReadOnly): sign-ins, API keys
 * and custom endpoints read only under the note that they change on the
 * computer, which refuses those writes to a paired client; the route order
 * and the table of what each model runs on, which a paired client may change.
 */
import { useEffect, useState, type ReactNode } from "react";
import { View } from "react-native";
import { REMOTE_CHANGE_NOTE, notThere } from "@ue-mcp-studio/client-core";
import { DEFAULT_ROUTE_ORDER, KEY_PROVIDER_IDS, OFFERED_SIGN_INS, PROVIDERS, routesInOrder, type CustomEndpoint, type ModelCatalog, type ProviderId, type RouteOrder, type SignInId, type StudioSettings } from "@ue-mcp-studio/shared";
import { Banner, Button, Card, Dot, bannerText, font, T, useTheme } from "../../ui";
import { CardLabel, Head, Seg, SettingRow, Span, Tag, Txt, useMessage } from "./controls";
import { Message } from "./GeneralSection";
import { PathText } from "./NativePanel";
import { useSettingsApi } from "./hooks";

const ROUTE_ORDER_OPTIONS: ReadonlyArray<{ id: RouteOrder; name: string }> = [
  { id: "signins-first", name: "Sign-ins first" },
  { id: "keys-first", name: "Keys first" },
];

/** The vendor whose models each sign-in runs. */
const SIGN_IN_VENDOR: Record<SignInId, string> = { claude: "anthropic", chatgpt: "openai", studio: "anthropic" };
const ROUTE_NAME: Record<SignInId | "key", string> = { claude: "Claude sign-in", chatgpt: "ChatGPT sign-in", studio: "Studio plan", key: "key" };

/** Anthropic's reason the Claude row has no sign-in button. */
const CLAUDE_LOGIN_WHY = "Anthropic does not allow apps it has not approved to offer Claude sign-in themselves. You sign in with Claude Code, and Studio runs Claude on that login. Studio never sees your Claude credentials.";

/**
 * fieldset.remote-readonly[disabled]: the note, then what it covers drawn at
 * 70% with every control off.
 */
export function ReadOnly({ children }: { children: ReactNode }) {
  return (
    <>
      <Txt size={12} tone="dim" style={{ marginBottom: 8 }}>
        {REMOTE_CHANGE_NOTE}
      </Txt>
      <View style={{ opacity: 0.7, gap: 14 }}>{children}</View>
    </>
  );
}

export function ModelsSection() {
  const api = useSettingsApi();
  const t = useTheme();
  const [settings, setSettings] = useState<StudioSettings | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const msg = useMessage();
  const refresh = () => {
    api.settings().then(setSettings, msg.fail);
    api.models().then(setCatalog, () => setCatalog(null));
  };
  useEffect(refresh, [api]);
  if (!settings) return msg.message ? <Message msg={msg} /> : <Txt tone="muted" style={{ marginVertical: t.base.size }}>Loading</Txt>;
  const vendorRank = (id: string): number => {
    const v = (KEY_PROVIDER_IDS as readonly string[]).includes(id) ? id : SIGN_IN_VENDOR[id as SignInId];
    const i = (KEY_PROVIDER_IDS as readonly string[]).indexOf(v ?? "");
    return i < 0 ? KEY_PROVIDER_IDS.length : i;
  };
  const byVendor = <T extends ProviderId>(ids: readonly T[]): T[] => [...ids].sort((a, b) => vendorRank(a) - vendorRank(b));
  const order = settings.routeOrder ?? DEFAULT_ROUTE_ORDER;
  const setOrder = (routeOrder: RouteOrder) => api.saveSettings({ routeOrder }).then(refresh, msg.fail);
  const keyOnly = KEY_PROVIDER_IDS.filter((v) => !OFFERED_SIGN_INS.some((s) => SIGN_IN_VENDOR[s] === v)).map((v) => PROVIDERS[v].name);
  return (
    <>
      <Head title="Models & accounts" lead="How models are reached on this machine." />
      <Message msg={msg} />
      <View>
        <ReadOnly>
          <Card>
            <CardLabel>Sign-ins</CardLabel>
            <Txt size={12} tone="dim" style={{ marginBottom: 12 }}>
              Runs the vendor's models on your plan.
            </Txt>
            {byVendor(OFFERED_SIGN_INS).map((p, i) => (
              <ProviderRow key={p} provider={p} settings={settings} first={i === 0} />
            ))}
            {keyOnly.length > 0 ? (
              <Txt size={12} tone="dim" style={{ marginTop: 12 }}>
                {keyOnly.join(" and ")}: key only.
              </Txt>
            ) : null}
          </Card>
          <Card>
            <CardLabel>API keys</CardLabel>
            <Txt size={12} tone="dim" style={{ marginBottom: 12 }}>
              Stored on this machine, used by every project.
            </Txt>
            {byVendor(KEY_PROVIDER_IDS).map((p, i) => (
              <ProviderRow key={p} provider={p} settings={settings} first={i === 0} />
            ))}
          </Card>
          <EndpointsCard />
        </ReadOnly>
      </View>
      <Card>
        <CardLabel>Models</CardLabel>
        <SettingRow first title="Route order" help="For models a sign-in and a key can both run.">
          <Seg label="Route order" value={order} options={ROUTE_ORDER_OPTIONS} onChange={(o) => void setOrder(o)} />
        </SettingRow>
        <View>
          {[...(catalog?.providers ?? [])]
            .sort((a, b) => vendorRank(a.id) - vendorRank(b.id))
            .flatMap((v) =>
              v.models.map((m) => {
                const routes: Array<{ id: SignInId | "key" | "endpoint"; on: boolean }> = v.endpoint ? [{ id: "endpoint", on: true }] : routesInOrder(m.signIns, order).map((r) => ({ id: r, on: r === "key" ? v.connected : !!catalog!.signedIn[r] }));
                const runs = routes.find((r) => r.on);
                const routeName = (id: SignInId | "key" | "endpoint") => (id === "endpoint" ? v.name : id === "key" ? `${v.name} key` : ROUTE_NAME[id]);
                const failed = v.endpoint?.listError;
                return { key: `${v.id}:${m.id}`, v, m, routes, runs, routeName, failed };
              }),
            )
            .map(({ key, v, m, routes, runs, routeName, failed }, i, all) => (
              <View key={key} style={{ gap: 6, paddingVertical: 10, borderBottomWidth: i === all.length - 1 ? 0 : 1, borderBottomColor: t.c.line }}>
                <View>
                  <Txt size={12.5} weight={700}>
                    {v.name} {m.name}
                  </Txt>
                  {v.endpoint ? <Txt size={12} tone="dim">Custom endpoint</Txt> : null}
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <ColumnName>Routes</ColumnName>
                  <View>
                    {routes.map((r) => (
                      <View key={r.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                        <Dot kind={r.on ? (r.id === "endpoint" && failed ? "warn" : "ok") : undefined} />
                        <Txt size={12} tone={r.on ? "text" : "dim"}>
                          {routeName(r.id)}
                        </Txt>
                      </View>
                    ))}
                  </View>
                </View>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
                  <ColumnName>Runs on</ColumnName>
                  {runs ? (
                    runs.id === "endpoint" && failed ? (
                      <Tag kind="warn">{routeName(runs.id)}: models not read</Tag>
                    ) : (
                      <Tag kind="ok">{routeName(runs.id)}</Tag>
                    )
                  ) : (
                    <Txt size={12} tone="dim">
                      Not connected
                    </Txt>
                  )}
                </View>
              </View>
            ))}
        </View>
        <Txt size={12} tone="dim" style={{ marginTop: 12 }}>
          Vendors with a key list their current models{catalog?.providers.some((p) => p.source === "default") ? "; others show a built-in list" : ""}.
        </Txt>
      </Card>
    </>
  );
}

/** A narrow table cell's column name, as td[data-label]::before draws it. */
function ColumnName({ children }: { children: string }) {
  const t = useTheme();
  return <T style={[font(t, "mono", 500, 10.5, 1.4), { textTransform: "uppercase", letterSpacing: 0.84, color: t.c.dim }]}>{children}</T>;
}

/** One sign-in or vendor key: whether it is connected; its sign-in, sign-out and key buttons are the computer's. */
function ProviderRow({ provider, settings, first }: { provider: ProviderId; settings: StudioSettings; first: boolean }) {
  const t = useTheme();
  const connected = settings.connected[provider];
  const signIn = provider === "studio" || provider === "claude" || provider === "chatgpt";
  const status = provider === "claude" || provider === "chatgpt" ? (connected ? "Signed in" : "Not signed in") : signIn ? (settings.account ? `Signed in as @${settings.account.login}` : "Not signed in") : connected ? "Key saved" : "No key";
  return (
    <View style={{ flexDirection: "row", gap: 14, alignItems: "flex-start", paddingVertical: 11, borderTopWidth: first ? 0 : 1, borderTopColor: t.c.line }}>
      <Dot kind={connected ? "ok" : undefined} style={{ marginTop: 6 }} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt weight={500}>
          <Span weight={700}>{signIn ? ROUTE_NAME[provider as SignInId] : `${PROVIDERS[provider].name} key`}</Span> <Span size={12} tone="muted">{status}</Span>
        </Txt>
        {signIn && !connected ? (
          <Txt size={12} tone="dim" style={{ marginBottom: 8 }}>
            {REMOTE_CHANGE_NOTE}
          </Txt>
        ) : null}
      </View>
      {connected && provider === "studio" && settings.account?.via === "ue-mcp-login" ? (
        <Txt size={12} tone="dim" style={{ alignSelf: "center" }}>
          from ue-mcp login
        </Txt>
      ) : connected && provider === "claude" ? (
        <Txt size={12} tone="dim" style={{ alignSelf: "center" }} label={CLAUDE_LOGIN_WHY}>
          from Claude Code <Span size={12} tone="muted" style={{ textDecorationLine: "underline", textDecorationStyle: "dotted" }}>Why?</Span>
        </Txt>
      ) : connected ? (
        <Button title={signIn ? "Sign out" : "Remove key"} disabled />
      ) : signIn ? null : (
        <Button title="Add key" disabled />
      )}
    </View>
  );
}

/** Custom endpoints, read only: each one's address, models and whether its list was read. */
function EndpointsCard() {
  const api = useSettingsApi();
  const t = useTheme();
  const [list, setList] = useState<CustomEndpoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [absent, setAbsent] = useState(false);
  const load = () =>
    api.endpoints().then(
      (r) => {
        setList(r.endpoints);
        setError(null);
      },
      (e: Error) => (notThere(e) ? setAbsent(true) : setError(e.message)),
    );
  useEffect(() => void load(), [api]);
  if (absent) return null;
  return (
    <Card>
      <CardLabel actions={list ? <Button title="Add endpoint" disabled /> : undefined}>Custom endpoints</CardLabel>
      <Txt size={12} tone="dim" style={{ marginBottom: 12 }}>
        Any OpenAI Chat Completions server, local or hosted. Its models read AGENTS.md and .agents/skills.
      </Txt>
      {error ? (
        <Banner kind="bad" role="alert" style={{ marginBottom: 8, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Txt size={12} style={{ color: bannerText(t, "bad"), flex: 1 }}>
            {list ? error : `Could not read the endpoints: ${error}`}
          </Txt>
          {!list ? <Button title="Retry" disabled /> : null}
        </Banner>
      ) : null}
      {!list && !error ? <Txt size={12} tone="muted">Loading endpoints</Txt> : null}
      {list && list.length === 0 ? <Txt size={12} tone="muted">No endpoints.</Txt> : null}
      {list?.map((e, i) => (
        <View key={e.id} style={{ flexDirection: "row", flexWrap: "wrap", gap: 14, alignItems: "flex-start", paddingVertical: 11, borderTopWidth: i ? 1 : 0, borderTopColor: t.c.line }}>
          <Dot kind={e.listError ? "warn" : e.models.length ? "ok" : undefined} style={{ marginTop: 6 }} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Txt weight={500}>
              <Span weight={700}>{e.name}</Span> <Span size={12} tone="muted">{e.models.length === 1 ? "1 model" : `${e.models.length} models`}, {e.hasKey ? "key saved" : "no key"}</Span>
            </Txt>
            <View style={{ marginTop: 2 }}>
              <PathText p={e.baseUrl} dim />
            </View>
            {e.listError ? (
              <Txt size={12} tone="warn" style={{ marginTop: 4 }}>
                Could not read its models: {e.listError}. {e.models.length ? "Showing the last list." : "Add them in Edit."}
              </Txt>
            ) : null}
            {e.models.length > 0 ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                {e.models.map((m) => (
                  <Tag key={m.id}>{m.id}</Tag>
                ))}
              </View>
            ) : null}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, width: "100%", paddingLeft: 22 }}>
            <Button title="Read models" disabled />
            <Button title="Edit" disabled />
            <Button title="Remove" disabled />
          </View>
        </View>
      ))}
    </Card>
  );
}

