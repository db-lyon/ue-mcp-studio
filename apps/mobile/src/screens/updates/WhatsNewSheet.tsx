/**
 * What's new (client-web views/WhatsNew.tsx): an accordion per part with a
 * release newer than the installed one, each release's notes under its
 * version, newest first. Notes that could not be read say so, with Retry and
 * the release page. The notes go through the renderer's release-notes mode:
 * client-core's sanitiser, <details> as folds, and only web links open.
 */
import { useBack } from "../../back";
import { useCallback, useEffect, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, View } from "react-native";
import { NOTHING_NEW, WHATS_NEW_NO_NOTES, WHATS_NEW_PAGE, WHATS_NEW_TITLE, WHATS_NEW_UNAVAILABLE, componentRange, entryDate, moreLine, readWhatsNewWith, shownComponents, whatsNewError } from "@ue-mcp-studio/client-core";
import type { WhatsNew, WhatsNewComponent } from "@ue-mcp-studio/shared";
import { Banner, Button, Markdown, Spacer, bannerText, font, T, useSheetInsets, useTheme } from "../../ui";
import { FOLD_GAP } from "../../ui/Markdown";
import { Txt, pageScroll } from "../settings/controls";
import { Details } from "../settings/Details";
import { useSettingsApi } from "../settings/hooks";

const open = (url: string) => void Linking.openURL(url).catch(() => undefined);

function Part({ c, startOpen, retry, retrying }: { c: WhatsNewComponent; startOpen: boolean; retry: () => void; retrying: boolean }) {
  const t = useTheme();
  const [isOpen, setOpen] = useState(startOpen);
  return (
    // As the web's .whats-new-part: a box whose header is on the lighter panel2 and whose content is on the darker bg, both full width.
    <View style={{ borderWidth: 1, borderColor: t.c.line, borderRadius: 8, overflow: "hidden" }}>
      <Details
        startOpen={startOpen}
        onToggle={setOpen}
        label={`${c.name}, ${componentRange(c)}`}
        summaryStyle={{ alignItems: "center", paddingHorizontal: 12, backgroundColor: t.c.panel2, borderBottomWidth: isOpen ? 1 : 0, borderBottomColor: t.c.line }}
        summary={
          <Txt style={{ flexShrink: 1, marginLeft: FOLD_GAP }}>
            <Txt weight={600}>{c.name}</Txt> <Txt size={12} tone="dim">{componentRange(c)}</Txt>
          </Txt>
        }
      >
        <View style={{ padding: 12, backgroundColor: t.c.bg }}>
          {c.error ? (
            <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}>
              <Txt size={12} style={{ color: bannerText(t, "bad") }}>
                {whatsNewError(c)}
              </Txt>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 8 }}>
                <Button title={retrying ? "Retrying" : "Retry"} disabled={retrying} onPress={retry} />
                {c.releasesUrl ? <Button variant="ghost" title={WHATS_NEW_PAGE} onPress={() => open(c.releasesUrl)} /> : null}
              </View>
            </Banner>
          ) : (
            <>
              {c.entries.map((e, i) => (
                <View key={e.version} style={i > 0 ? { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.c.line } : null}>
                  <View style={{ flexDirection: "row", alignItems: "baseline", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                    <T accessibilityRole="header" style={[font(t, "mono", 600, 13, 1.4), { color: t.c.text }]}>
                      {e.version}
                    </T>
                    {entryDate(e.publishedAt) ? <Txt size={12} tone="dim">{entryDate(e.publishedAt)}</Txt> : null}
                    <Spacer />
                    {e.url ? (
                      <Txt size={12} tone="accentHi" onPress={() => open(e.url)} label={WHATS_NEW_PAGE}>
                        {WHATS_NEW_PAGE}
                      </Txt>
                    ) : null}
                  </View>
                  {e.body ? <Markdown notes breaks={false} paragraphMargin={8} text={e.body} /> : <Txt size={12} tone="dim">{WHATS_NEW_NO_NOTES}</Txt>}
                </View>
              ))}
              {c.more > 0 ? (
                <Txt size={12} tone="accentHi" style={{ marginTop: 12 }} onPress={() => open(c.releasesUrl)}>
                  {moreLine(c.more)}
                </Txt>
              ) : null}
            </>
          )}
        </View>
      </Details>
    </View>
  );
}

export function WhatsNewSheet({ onClose }: { onClose: () => void }) {
  const api = useSettingsApi();
  const t = useTheme();
  const insets = useSheetInsets();
  // undefined while the first read runs; null when the agent had no answer.
  const [w, setW] = useState<WhatsNew | null | undefined>(undefined);
  const [retrying, setRetrying] = useState(false);
  useBack(onClose, { overlay: true });
  const load = useCallback(
    (refresh: boolean) =>
      void readWhatsNewWith((p) => api.maybe(p), refresh)
        .then(setW, () => setW(null))
        .finally(() => setRetrying(false)),
    [api],
  );
  useEffect(() => load(false), [load]);
  const retry = () => {
    setRetrying(true);
    load(true);
  };
  const parts = shownComponents(w ?? null);
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, paddingTop: 8 + insets.top, paddingBottom: 8 + insets.bottom, paddingLeft: 8 + insets.left, paddingRight: 8 + insets.right, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 0, 0, 0.55)" }}>
        <Pressable accessibilityViewIsModal accessibilityLabel={WHATS_NEW_TITLE} testID="whats-new" onPress={() => undefined} style={{ width: "100%", maxWidth: 680, maxHeight: "100%", borderWidth: 1, borderColor: t.c.line, borderRadius: 10, backgroundColor: t.c.panel, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 18 } }}>
          <ScrollView style={pageScroll} contentContainerStyle={{ gap: 10, padding: 16 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <T accessibilityRole="header" style={[font(t, "sans", 600, 15, 1.2), { color: t.c.text }]}>
                {WHATS_NEW_TITLE}
              </T>
              <Spacer />
              <Button variant="ghost" title="Close" onPress={onClose} />
            </View>
            {w === undefined ? <Txt tone="muted">Loading</Txt> : null}
            {w === null ? (
              <Banner kind="bad" role="alert">
                <Txt size={12} style={{ color: bannerText(t, "bad") }}>
                  {WHATS_NEW_UNAVAILABLE}
                </Txt>
                <View style={{ flexDirection: "row", marginTop: 8 }}>
                  <Button title={retrying ? "Retrying" : "Retry"} disabled={retrying} onPress={retry} />
                </View>
              </Banner>
            ) : null}
            {w && parts.length === 0 ? <Txt tone="muted">{NOTHING_NEW}</Txt> : null}
            {parts.map((c) => (
              <Part key={c.part} c={c} startOpen={c === parts[0]} retry={retry} retrying={retrying} />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
