/**
 * Send feedback (client-web views/Feedback.tsx): report a problem or suggest
 * an idea, filed as an issue on Studio's GitHub tracker, with the installed
 * versions when the user includes them. When it cannot be filed, the same
 * report opens on GitHub in the phone's browser to send from there.
 */
import { useEffect, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { FeedbackReport, FeedbackResult } from "@ue-mcp-studio/shared";
import { Banner, Button, Input, Spacer, bannerText, font, T, useTheme } from "../../ui";
import { Box, Txt, pageScroll, ratio } from "../settings/controls";
import { Details } from "../settings/Details";
import { useSettingsApi } from "../settings/hooks";

const open = (url: string) => void Linking.openURL(url);

export function FeedbackSheet({ onClose, initial }: { onClose: () => void; initial?: { title: string; description: string } }) {
  const api = useSettingsApi();
  const t = useTheme();
  const [kind, setKind] = useState<FeedbackReport["kind"]>("problem");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [includeEnvironment, setIncludeEnvironment] = useState(true);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FeedbackResult | null>(null);
  useEffect(() => {
    api.feedbackEnvironment().then((e) => setEnvironment(e.body), () => setEnvironment(null));
  }, [api]);
  const ready = title.trim().length >= 5 && description.trim().length >= 20;
  const send = () => {
    setSending(true);
    setError(null);
    api
      .sendFeedback({ kind, title, description, includeEnvironment })
      .then((r) => {
        setResult(r);
        // Nothing written is lost: the same report opens on GitHub to finish there.
        if (!r.filed) open(r.link);
      }, (e: Error) => setError(e.message))
      .finally(() => setSending(false));
  };
  const field = font(t, "sans", 400, t.base.size, ratio(t));
  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable accessibilityLabel="Close" onPress={onClose} style={{ flex: 1, padding: 8, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 0, 0, 0.55)" }}>
        <Pressable accessibilityViewIsModal accessibilityLabel="Send feedback" onPress={() => undefined} style={{ width: "100%", maxWidth: 580, maxHeight: "100%", borderWidth: 1, borderColor: t.c.line, borderRadius: 10, backgroundColor: t.c.panel, shadowColor: "#000", shadowOpacity: 0.45, shadowRadius: 25, shadowOffset: { width: 0, height: 18 } }}>
          <ScrollView style={pageScroll} contentContainerStyle={{ gap: 12, padding: 16 }} keyboardShouldPersistTaps="handled">
            <T style={[font(t, "sans", 600, 15, 1.2), { color: t.c.text }]}>Send feedback</T>
            {result?.filed ? (
              <>
                <Txt tone="muted" style={{ marginVertical: t.base.size }}>
                  Filed as{" "}
                  <Txt tone="accentHi" onPress={() => open(result.url)}>
                    issue #{result.number}
                  </Txt>{" "}
                  on Studio's tracker. Thanks.
                </Txt>
                <Actions>
                  <Button variant="primary" title="Done" onPress={onClose} />
                </Actions>
              </>
            ) : result ? (
              <>
                <Txt tone="muted" style={{ marginVertical: t.base.size }}>
                  {result.reason} The report opened on GitHub, filled in, to send from there.
                </Txt>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 }}>
                  <Button variant="ghost" title="Open it again" onPress={() => open(result.link)} />
                  <Spacer />
                  <Button variant="primary" title="Done" onPress={onClose} />
                </View>
              </>
            ) : (
              <>
                <View accessibilityRole="radiogroup" accessibilityLabel="Kind" style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginVertical: 6 }}>
                  {(["problem", "idea"] as const).map((k) => {
                    const on = kind === k;
                    return (
                      <Button
                        key={k}
                        variant={on ? "default" : "ghost"}
                        title={k === "problem" ? "Report a problem" : "Suggest an idea"}
                        onPress={() => setKind(k)}
                        style={on ? { backgroundColor: t.c.accentWash, borderColor: t.c.accentLine } : undefined}
                      />
                    );
                  })}
                </View>
                <Input accessibilityLabel="Title" placeholder={kind === "problem" ? "What went wrong, in a line" : "The idea, in a line"} value={title} onChangeText={setTitle} maxLength={200} />
                <View>
                <TextInput
                  accessibilityLabel="Description"
                  multiline
                  numberOfLines={7}
                  placeholder={kind === "problem" ? "What you did, what you expected, and what happened instead." : "What you would like Studio to do, and why."}
                  placeholderTextColor={t.c.dim}
                  selectionColor={t.c.selection}
                  value={description}
                  onChangeText={setDescription}
                  textAlignVertical="top"
                  style={[field, { color: t.c.text, minHeight: 120, height: 7 * t.base.lineHeight + 14, backgroundColor: t.c.panel2, borderWidth: 1, borderColor: t.c.lineStrong, borderRadius: t.radius, paddingVertical: 6, paddingHorizontal: 10 }]}
                />
                {/* The textarea's resize grip (resize: vertical), drawn where the browser draws it. */}
                <Svg pointerEvents="none" width={9} height={9} viewBox="0 0 9 9" style={{ position: "absolute", right: 2, bottom: 2 }} stroke={t.c.dim} strokeWidth={1}>
                  <Path d="M8.5 1.5L1.5 8.5M8.5 5.5L5.5 8.5" />
                </Svg>
                </View>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: includeEnvironment }} onPress={() => setIncludeEnvironment(!includeEnvironment)} style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, minHeight: 44, paddingVertical: 10, marginVertical: 6 }}>
                  <Box on={includeEnvironment} style={{ marginTop: 1 }} />
                  <Txt size={12} tone="muted" style={{ flex: 1 }}>
                    Include the installed versions, engine, OS and model
                  </Txt>
                </Pressable>
                {includeEnvironment && environment ? (
                  <Details summary={<Txt size={12} tone="dim">What gets added</Txt>}>
                    <View style={{ marginTop: 6, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, backgroundColor: t.c.bg }}>
                      <T style={[font(t, "mono", 400, 12, 1.5), { color: t.c.dim }]}>{environment}</T>
                    </View>
                  </Details>
                ) : null}
                <Txt size={12} tone="dim" style={{ marginVertical: 12 }}>
                  Filed publicly on github.com/db-lyon/ue-mcp-studio. No keys, files or project names are sent.
                </Txt>
                {error ? (
                  <Banner kind="bad">
                    <Txt size={12} style={{ color: bannerText(t, "bad") }}>
                      {error}
                    </Txt>
                  </Banner>
                ) : null}
                <Actions>
                  <Button variant="ghost" title="Cancel" onPress={onClose} />
                  <Button variant="primary" title={sending ? "Sending" : "Send"} disabled={!ready || sending} onPress={send} />
                </Actions>
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginVertical: 6 }}>
      <Spacer />
      {children}
    </View>
  );
}
