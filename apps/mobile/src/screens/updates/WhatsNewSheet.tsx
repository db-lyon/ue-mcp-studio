/**
 * What's new (client-web views/WhatsNew.tsx): an accordion per part with a
 * release newer than the installed one, each release's notes under its
 * version, newest first. Notes that could not be read say so, with Retry and
 * the release page. The notes go through the renderer's release-notes mode:
 * client-core's sanitiser, <details> as folds, and only web links open.
 *
 * Scrolling on Android: an open part's notes are a scroll box of their own
 * under the part's header, at most WHATS_NEW_BODY_SHARE of the screen tall,
 * and the list of parts scrolls under the fixed title when the open parts
 * overflow it. Every scroll view has a height bounded by a number taken from
 * the window, and both set nestedScrollEnabled so the inner one scrolls before
 * the outer. No touchable is an ancestor of a scroll view: a Pressable that
 * becomes the JS responder makes its native view intercept every move of the
 * gesture (JSResponderHandler.onInterceptTouchEvent), so a scroll view inside
 * it is cancelled before it can scroll. The backdrop that closes the sheet is
 * a sibling behind the card for that reason, as ui/Sheet does.
 */
import { useBack } from "../../back";
import { useCallback, useEffect, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import { NOTHING_NEW, WHATS_NEW_NO_NOTES, WHATS_NEW_PAGE, WHATS_NEW_TITLE, WHATS_NEW_UNAVAILABLE, componentRange, entryDate, moreLine, readWhatsNewWith, shownComponents, whatsNewError } from "@ue-mcp-studio/client-core";
import type { WhatsNew, WhatsNewComponent } from "@ue-mcp-studio/shared";
import { Banner, Button, Markdown, Spacer, bannerText, font, T, useSheetInsets, useTheme } from "../../ui";
import { FOLD_GAP } from "../../ui/Markdown";
import { Txt, pageScroll } from "../settings/controls";
import { Details } from "../settings/Details";
import { useSettingsApi } from "../settings/hooks";

const open = (url: string) => void Linking.openURL(url).catch(() => undefined);

/** The share of the screen's height an open part's notes may take before they scroll inside it; less on a short screen. */
export function whatsNewBodyMax(screenHeight: number): number {
  return Math.max(160, Math.round(screenHeight * (screenHeight < 640 ? 0.45 : 0.55)));
}

function Part({ c, startOpen, retry, retrying, bodyMax }: { c: WhatsNewComponent; startOpen: boolean; retry: () => void; retrying: boolean; bodyMax: number }) {
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
        {/* The part's own scroll box: a numeric maxHeight, so it is bounded inside the Modal, and nested so it scrolls before the list around it. */}
        <ScrollView testID={`whats-new-part-body-${c.part}`} style={[{ maxHeight: bodyMax, flexGrow: 0, backgroundColor: t.c.bg }, pageScroll]} contentContainerStyle={{ padding: 12 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
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
        </ScrollView>
      </Details>
    </View>
  );
}

export function WhatsNewSheet({ onClose }: { onClose: () => void }) {
  const api = useSettingsApi();
  const t = useTheme();
  const insets = useSheetInsets();
  const { height } = useWindowDimensions();
  // Numbers, not percentages, so every height below is bounded on the phone.
  const cardMax = Math.max(200, height - insets.top - insets.bottom - 16);
  const bodyMax = whatsNewBodyMax(height);
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
      {/* The backdrop is a sibling behind the card, never a touchable around it: see the note at the top of this file. */}
      <Pressable testID="whats-new-backdrop" accessibilityLabel="Close" onPress={onClose} style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0, 0, 0, 0.55)" }]} />
      <View pointerEvents="box-none" style={{ flex: 1, paddingTop: 8 + insets.top, paddingBottom: 8 + insets.bottom, paddingLeft: 8 + insets.left, paddingRight: 8 + insets.right, alignItems: "center", justifyContent: "center" }}>
        <View accessibilityViewIsModal accessibilityLabel={WHATS_NEW_TITLE} testID="whats-new" style={{ width: "100%", maxWidth: 680, maxHeight: cardMax, borderWidth: 1, borderColor: t.c.line, borderRadius: 10, backgroundColor: t.c.panel, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 18 } }}>
          <View testID="whats-new-head" style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 10 }}>
            <T accessibilityRole="header" style={[font(t, "sans", 600, 15, 1.2), { color: t.c.text }]}>
              {WHATS_NEW_TITLE}
            </T>
            <Spacer />
            <Button variant="ghost" title="Close" onPress={onClose} />
          </View>
          {/* The list of parts: shrinks to the card's numeric maxHeight and scrolls when the open parts overflow it. */}
          <ScrollView testID="whats-new-body" style={[{ flexGrow: 0, flexShrink: 1 }, pageScroll]} contentContainerStyle={{ gap: 10, paddingHorizontal: 16, paddingBottom: 16 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
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
              <Part key={c.part} c={c} startOpen={c === parts[0]} retry={retry} retrying={retrying} bodyMax={bodyMax} />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
