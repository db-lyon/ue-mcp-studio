/**
 * Pairing, in Studio's design language: the welcome page with Scan and a
 * pasted link, the code to compare with the computer's, and each step's
 * status. The scanner itself is ./Scanner.
 */
import { useState } from "react";
import { View } from "react-native";
import { formatPairingCode } from "@ue-mcp-studio/remote";
import type { PairStep } from "../relay";
import { Banner, Button, Card, font, Input, Spinner, T, useTheme } from "../ui";
import { Brand } from "../views/NavDrawer";
import { Page } from "./StudioPage";

/** .display: a serif accent word, then the rest. */
function Display({ em, rest }: { em: string; rest: string }) {
  const t = useTheme();
  return (
    <T accessibilityRole="header" style={{ ...font(t, "sans", 700, t.editor ? 24 : 28, 1.1), letterSpacing: t.editor ? 0 : -0.84, color: t.c.text, textAlign: "center" }}>
      <T style={t.editor ? { ...font(t, "sans", 700, 24, 1.1), color: t.c.text } : { ...font(t, "serif", 400, 42, 1, true), color: t.c.accent, letterSpacing: -0.42 }}>{em}</T> {rest}
    </T>
  );
}

export function Welcome({ error, onScan, onLink }: { error?: string; onScan: () => void; onLink: (link: string) => void }) {
  const t = useTheme();
  const [link, setLink] = useState("");
  return (
    <Page>
      <View style={{ alignItems: "center", paddingTop: 8 }}>
        <Brand />
      </View>
      <View style={{ alignItems: "center", gap: 10, paddingTop: 28, paddingHorizontal: 6 }}>
        <Display em="Pair" rest="this phone." />
        <T style={{ color: t.c.muted, textAlign: "center", fontSize: 13.5, marginBottom: 6 }}>In Studio on your computer, open Remote and show the pairing code. Scan it here, or paste its link below.</T>
        {error ? (
          <Banner kind="bad" role="alert" style={{ alignSelf: "stretch", marginBottom: 0 }}>
            {error}
          </Banner>
        ) : null}
        <Button title="Scan pairing code" variant="primary" size="large" onPress={onScan} style={{ marginTop: 6 }} />
      </View>
      <Card style={{ marginTop: 18, gap: 10 }}>
        <T style={{ ...font(t, "sans", 600, 12, 1.3), color: t.c.dim }}>Or paste the pairing link</T>
        <Input value={link} onChangeText={setLink} placeholder="https://remote.ue-mcp.com/pair#..." autoCapitalize="none" autoCorrect={false} accessibilityLabel="Pairing link" />
        <Button title="Pair with link" disabled={!link.trim()} onPress={() => onLink(link)} style={{ alignSelf: "flex-start" }} />
      </Card>
    </Page>
  );
}

export function Pairing({ step }: { step: PairStep }) {
  const t = useTheme();
  if (step.kind === "code")
    return (
      <Page>
        <View style={{ alignItems: "center", gap: 10, paddingTop: 48 }}>
          <Display em="Approve" rest="on your computer." />
          <T style={{ color: t.c.muted, textAlign: "center" }}>Studio on your computer shows the same code:</T>
          <T accessibilityLabel={`Pairing code ${step.code.split("").join(" ")}`} style={{ ...font(t, "mono", 600, 40, 1.2), letterSpacing: 3.2, color: t.c.text, marginVertical: 8 }}>
            {formatPairingCode(step.code)}
          </T>
          <T style={{ ...font(t, "sans", 400, 12, 1.5), color: t.c.dim, textAlign: "center" }}>If the code on your computer is different, choose Deny there.</T>
          <View style={{ marginTop: 18 }}>
            <Spinner />
          </View>
        </View>
      </Page>
    );
  return (
    <Page scroll={false}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }} accessibilityRole="text" accessibilityLiveRegion="polite">
        <Spinner />
        <T style={{ color: t.c.muted }}>{step.text}</T>
      </View>
    </Page>
  );
}
