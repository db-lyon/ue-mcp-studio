/**
 * Plugins, as a paired browser shows it (client-web views/Plugins.tsx with
 * `remote`): the project's installed plugins and the registry's catalog, read
 * only, under the note that changes run on the computer. Install, update and
 * remove are refused to a paired client, so none is offered.
 */
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { HttpError, REMOTE_PLUGINS_NOTE, isInstalled, searchCatalog, type CatalogPlugin, type InstalledPlugin } from "@ue-mcp-studio/client-core";
import { Banner, Button, Card, Input, Markdown, Pill, Spacer, bannerText, useTheme } from "../../ui";
import { CardLabel, Txt } from "../settings/controls";
import { useSettingsApi } from "../settings/hooks";
import type { DaemonState } from "../../state";

export function PluginsScreen({ daemon }: { daemon: DaemonState }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [installed, setInstalled] = useState<InstalledPlugin[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogPlugin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.plugins().then((r) => setInstalled(r.plugins), (e: Error) => {
      if (e instanceof HttpError && e.status === 404) setUnsupported(true);
      else setError(e.message);
    });
    api.pluginCatalog().then((r) => setCatalog(r.plugins), (e: Error) => setError(e.message));
  }, [api]);
  // Another client changed the plugins: read them again.
  const changes = daemon.events.filter((e) => e.type === "plugins.changed").length;
  useEffect(() => {
    if (changes) api.plugins().then((r) => setInstalled(r.plugins), () => undefined);
  }, [changes]);

  const shown = useMemo(() => searchCatalog(catalog ?? [], query), [catalog, query]);
  /** A paragraph's 1em margin, and what is left of it over the 12px the title or note above already gives. */
  const para = t.base.size;
  const after12 = { marginTop: para - 12, marginBottom: para };

  if (unsupported) {
    return (
      <ScrollView testID="plugins" style={{ flex: 1 }} contentContainerStyle={{}}>
        <Card>
          <CardLabel>Plugins</CardLabel>
          <Txt tone="muted" style={{ marginBottom: para }}>
            Managing plugins here needs ue-mcp 1.4.0-beta.2 or later. Until then: <Txt mono>npx ue-mcp plugin install &lt;name&gt;</Txt> in the project folder.
          </Txt>
        </Card>
      </ScrollView>
    );
  }

  return (
    <ScrollView testID="plugins" style={{ flex: 1 }} contentContainerStyle={{ gap: 14 }} keyboardShouldPersistTaps="handled">
      {error ? (
        <Pressable accessibilityRole="alert" onPress={() => setError(null)}>
          <Banner kind="bad">
            <Txt style={{ color: bannerText(t, "bad") }}>{error}</Txt>
          </Banner>
        </Pressable>
      ) : null}
      <Banner style={{ marginTop: para }}>
        <Txt>{REMOTE_PLUGINS_NOTE}</Txt>
      </Banner>

      <Card>
        <CardLabel>Installed</CardLabel>
        {installed === null ? <Txt tone="muted" style={after12}>Loading</Txt> : null}
        {installed?.length === 0 ? <Txt tone="muted" style={after12}>No plugins in this project yet. Browse the catalog below.</Txt> : null}
        {installed?.map((p, i) => (
          <View key={p.name} style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: i === installed.length - 1 ? 0 : 1, borderBottomColor: t.c.line }}>
            <Txt weight={700}>{p.name}</Txt>
            <Txt size={12} tone="dim">
              {p.version ?? "not installed"}
              {p.pinned ? `, pinned ${p.pinned}` : ""}
            </Txt>
            <Pill kind={p.status === "ok" ? "ok" : "bad"} style={{ alignSelf: "center" }}>
              {p.status}
            </Pill>
            {p.categories.length > 0 ? (
              <Txt size={12} tone="dim">
                adds {p.categories.join(", ")}
              </Txt>
            ) : null}
            {p.problems.length > 0 ? (
              <Txt size={12} tone="dim" style={{ flexBasis: "100%" }}>
                {p.problems.join("; ")}
              </Txt>
            ) : null}
          </View>
        ))}
      </Card>

      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
          <CardLabel>Browse</CardLabel>
          <Spacer />
          <Input accessibilityLabel="Search plugins" placeholder="Search plugins" value={query} onChangeText={setQuery} style={{ width: 240, maxWidth: "100%" }} />
        </View>
        {/* p.small after a .row: their margins collapse to 12. */}
        <Txt size={12} tone="muted" style={{ marginTop: 6, marginBottom: 12 }}>
          From the ue-mcp plugin registry at plugins.ue-mcp.com.
        </Txt>
        {catalog === null ? <Txt tone="muted" style={after12}>Loading</Txt> : null}
        {catalog !== null && shown.length === 0 ? <Txt tone="muted" style={after12}>No plugin matches.</Txt> : null}
        <View style={{ gap: 10 }}>
          {shown.map((c) => {
            const have = installed ? isInstalled(c, installed) : undefined;
            const isOpen = open === c.slug;
            return (
              <View key={c.slug} style={{ gap: 6, padding: 12, borderWidth: 1, borderColor: t.c.line, borderRadius: 8, backgroundColor: t.c.panel2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
                  <Txt weight={700}>{c.name}</Txt>
                  {c.category ? <Pill style={{ alignSelf: "center" }}>{c.category}</Pill> : null}
                  <Spacer />
                  {have ? (
                    <Pill kind="ok" style={{ alignSelf: "center" }}>
                      installed
                    </Pill>
                  ) : null}
                </View>
                {c.tagline ? <Txt size={12}>{c.tagline}</Txt> : null}
                <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10, marginVertical: 6 }}>
                  <Button variant="ghost" size="small" fontSize={12} title={isOpen ? "Hide details" : "Details"} onPress={() => setOpen(isOpen ? null : c.slug)} />
                  {c.repoUrl ? <LinkOut url={c.repoUrl}>Source</LinkOut> : null}
                  {c.homepageUrl ? <LinkOut url={c.homepageUrl}>Homepage</LinkOut> : null}
                </View>
                {isOpen ? (
                  <ScrollView nestedScrollEnabled style={{ maxHeight: 420, paddingVertical: 8, paddingHorizontal: 12, borderTopWidth: 1, borderTopColor: t.c.line }}>
                    <Markdown page breaks={false} paragraphMargin={0} text={c.readme ?? c.description ?? "No description."} />
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

/** An a in the catalog card: the link colour, opened in the phone's browser. */
function LinkOut({ url, children }: { url: string; children: string }) {
  return (
    <Txt size={12} tone="accentHi" onPress={() => void Linking.openURL(url)} label={children}>
      {children}
    </Txt>
  );
}
