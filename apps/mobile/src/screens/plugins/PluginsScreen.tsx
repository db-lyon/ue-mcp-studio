/**
 * Plugins, as a paired browser shows it (client-web views/Plugins.tsx with
 * `remote`): the project's installed plugins and the registry's catalog, read
 * only, under the note that changes run on the computer. Install, update and
 * remove are refused to a paired client, so none is offered.
 */
import { useEffect, useMemo, useState } from "react";
import { Linking, ScrollView, Text, View } from "react-native";
import { HttpError, REMOTE_PLUGINS_NOTE, isInstalled, searchCatalog, type CatalogPlugin, type InstalledPlugin } from "@ue-mcp-studio/client-core";
import { Banner, BannerText, Btn, Card, Field, Label, Pill, Row, Spacer, T, baseText } from "../../ui/kit";
import { useTokens } from "../../ui/studio-theme";
import { Markdown } from "../../Markdown";
import { useProjectEvents, useSettingsApi } from "../settings/hooks";

export function PluginsScreen() {
  const api = useSettingsApi();
  const t = useTokens();
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    api.plugins().then((r) => setInstalled(r.plugins), (e: Error) => {
      if (e instanceof HttpError && e.status === 404) setUnsupported(true);
      else setError(e.message);
    });
    api.pluginCatalog().then((r) => setCatalog(r.plugins), (e: Error) => setError(e.message));
  };
  useEffect(load, [api]);
  // Another client changed the plugins: read them again.
  useProjectEvents((e) => {
    if (e.type === "plugins.changed") api.plugins().then((r) => setInstalled(r.plugins), () => undefined);
  });

  const shown = useMemo(() => searchCatalog(catalog ?? [], query), [catalog, query]);

  if (unsupported) {
    return (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 6 }}>
        <Card>
          <Label style={{ marginBottom: 12 }}>Plugins</Label>
          <Text style={[baseText(t), { color: t.muted, marginVertical: t.base.size }]}>
            Managing plugins here needs ue-mcp 1.4.0-beta.2 or later. Until then: <Text style={{ fontFamily: t.mono, fontSize: t.base.size * 0.92 * 0.92 }}>npx ue-mcp plugin install &lt;name&gt;</Text> in the project folder.
          </Text>
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView testID="plugins" style={{ flex: 1 }} contentContainerStyle={{ padding: 6, gap: 14 }} keyboardShouldPersistTaps="handled">
      {error ? (
        <Banner kind="bad" onPress={() => setError(null)}>
          <BannerText>{error}</BannerText>
        </Banner>
      ) : null}
      <Banner style={{ marginTop: t.base.size }}>
        <BannerText>{REMOTE_PLUGINS_NOTE}</BannerText>
      </Banner>

      <Card>
        <Label style={{ marginBottom: 12 }}>Installed</Label>
        {installed === null ? <T tone="muted" style={{ marginVertical: t.base.size }}>Loading</T> : null}
        {installed?.length === 0 ? <T tone="muted" style={{ marginVertical: t.base.size }}>No plugins in this project yet. Browse the catalog below.</T> : null}
        {installed?.map((p, i) => (
          <View key={p.name} testID={`plugin-${p.name}`} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: i === installed.length - 1 ? 0 : 1, borderBottomColor: t.line }}>
            <T weight="700">{p.name}</T>
            <T tone="dim" small>
              {p.version ?? "not installed"}
              {p.pinned ? `, pinned ${p.pinned}` : ""}
            </T>
            <Pill kind={p.status === "ok" ? "ok" : "bad"}>{p.status}</Pill>
            {p.categories.length > 0 ? <T tone="dim" small>adds {p.categories.join(", ")}</T> : null}
            {p.problems.length > 0 ? (
              <T tone="dim" small style={{ flexBasis: "100%" }}>
                {p.problems.join("; ")}
              </T>
            ) : null}
          </View>
        ))}
      </Card>

      <Card>
        <Row>
          <Label>Browse</Label>
          <Spacer />
          <Field accessibilityLabel="Search plugins" placeholder="Search plugins" value={query} onChangeText={setQuery} style={{ width: 240, maxWidth: "100%" }} />
        </Row>
        <T tone="muted" small style={{ marginTop: 6, marginBottom: 12 }}>From the ue-mcp plugin registry at plugins.ue-mcp.com.</T>
        {catalog === null ? <T tone="muted" style={{ marginVertical: t.base.size }}>Loading</T> : null}
        {catalog !== null && shown.length === 0 ? <T tone="muted" style={{ marginVertical: t.base.size }}>No plugin matches.</T> : null}
        <View style={{ gap: 10 }}>
          {shown.map((c) => {
            const have = installed ? isInstalled(c, installed) : undefined;
            const isOpen = open === c.slug;
            return (
              <View key={c.slug} testID={`catalog-${c.slug}`} style={{ gap: 6, padding: 12, borderWidth: 1, borderColor: t.line, borderRadius: 8, backgroundColor: t.panel2 }}>
                <Row>
                  <T weight="700">{c.name}</T>
                  {c.category ? <Pill>{c.category}</Pill> : null}
                  <Spacer />
                  {have ? <Pill kind="ok">installed</Pill> : null}
                </Row>
                {c.tagline ? <T small style={{ margin: 0 }}>{c.tagline}</T> : null}
                <Row>
                  <Btn kind="ghost" small size={12} title={isOpen ? "Hide details" : "Details"} onPress={() => setOpen(isOpen ? null : c.slug)} />
                  {c.repoUrl ? <LinkOut url={c.repoUrl}>Source</LinkOut> : null}
                  {c.homepageUrl ? <LinkOut url={c.homepageUrl}>Homepage</LinkOut> : null}
                </Row>
                {isOpen ? (
                  <ScrollView nestedScrollEnabled style={{ maxHeight: 420, paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: t.line }}>
                    <Markdown text={c.readme ?? c.description ?? "No description."} />
                  </ScrollView>
                ) : null}
              </View>
            );
          })}
        </View>
      </Card>
    </ScrollView>
  );
}

function LinkOut({ url, children }: { url: string; children: string }) {
  const t = useTokens();
  return (
    <Text accessibilityRole="link" onPress={() => void Linking.openURL(url)} style={[baseText(t, 12), { color: t.accentHi }]}>
      {children}
    </Text>
  );
}

