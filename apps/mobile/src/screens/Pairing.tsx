/**
 * Pairing, as the relay's pairing pages draw it in Studio's look: the welcome
 * (scan the code, or paste its link), each step while the phone proves
 * itself, the code to compare while the computer's owner decides, paired,
 * and every way pairing can stop, each with the one way on. The scanner
 * itself is ./Scanner.
 */
import { useState } from "react";
import { View } from "react-native";
import { formatPairingCode } from "@ue-mcp-studio/remote";
import { REMOTE_PLANS } from "@ue-mcp-studio/shared";
import { isPairLink, type PairFailureKind, type PairStep } from "../relay";
import { readClipboard } from "../native/clipboard";
import { Banner, bannerText, Button, font, Input, Panel, T, useTheme, Waiting } from "../ui";
import { Page, StateView } from "./StudioPage";

/** The one way on from a pairing that cannot go further. */
export const NEW_CODE = "Make a new code in Studio on your computer and scan it with this phone.";

/** .state-lead's inline code: /remote, as the relay sets it. */
export function Code({ children }: { children: string }) {
  const t = useTheme();
  return <T style={{ ...font(t, "mono", 500, 12.5, 1.4), color: t.c.text, backgroundColor: t.c.panel2 }}>{` ${children} `}</T>;
}

function WelcomeLead() {
  const t = useTheme();
  return (
    <T style={{ color: t.c.dim, textAlign: "center", marginBottom: 6 }}>
      On the computer running Studio, type <Code>/remote</Code> in a chat, or open <T style={{ ...font(t, "sans", 600, t.base.size), color: t.c.muted }}>{"Settings > Remote control"}</T>. Scan the code it shows with this phone.
    </T>
  );
}

/**
 * Not paired yet: scan the code, or paste the link Studio copies under it.
 * `link` opens with the paste panel holding it.
 */
export function Welcome({ error, onScan, onLink, link: initial }: { error?: string; onScan: () => void; onLink: (link: string) => void; link?: string }) {
  const t = useTheme();
  const [pasting, setPasting] = useState(initial !== undefined);
  const [link, setLink] = useState(initial ?? "");
  const [wrong, setWrong] = useState(false);
  const [nothing, setNothing] = useState(false);

  const paste = () => {
    setPasting(true);
    setWrong(false);
    // A pairing link already on the clipboard goes straight into the field; without one, the panel says so.
    void readClipboard().then((text) => {
      if (isPairLink(text.trim())) setLink((v) => v || text.trim());
      else setNothing(true);
    });
  };
  const submit = () => {
    const l = link.trim();
    if (!isPairLink(l)) return setWrong(true);
    onLink(l);
  };

  return (
    <Page stage>
      <StateView
        glyph="phone"
        title="Pair this phone"
        lead={<WelcomeLead />}
        note={
          error ? (
            <Banner kind="bad" role="alert" style={{ marginBottom: 0 }}>
              <T style={{ color: bannerText(t, "bad"), textAlign: "center" }}>{error}</T>
            </Banner>
          ) : null
        }
        actions={
          pasting ? null : (
            <>
              <Button title="Scan pairing code" variant="primary" size="large" onPress={onScan} />
              <Button title="Paste pairing link" size="large" onPress={paste} />
            </>
          )
        }
      />
      {pasting ? (
        <Panel
          head="Paste the pairing link"
          text={
            <T style={{ color: t.c.muted }}>
              In Studio on your computer, choose <T style={{ ...font(t, "sans", 600, t.base.size), color: t.c.text }}>Copy link</T> under the code, then paste it here.
            </T>
          }
          actions={
            <>
              <Button title="Cancel" variant="ghost" onPress={() => (setPasting(false), setLink(""), setWrong(false))} />
              <Button title="Pair" variant="primary" disabled={!link.trim() || wrong} onPress={submit} />
            </>
          }
        >
          <Input
            value={link}
            onChangeText={(v) => (setLink(v), setWrong(false), setNothing(false))}
            onSubmitEditing={submit}
            placeholder="https://remote.ue-mcp.com/pair#..."
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            returnKeyType="go"
            accessibilityLabel="Pairing link"
            style={wrong ? { borderColor: t.c.bad } : undefined}
          />
          {nothing && !link && !wrong ? (
            <T style={{ ...font(t, "sans", 400, 12.5, t.base.lineHeight / t.base.size), color: t.c.dim }}>The clipboard has no pairing link.</T>
          ) : null}
          {wrong ? (
            <T accessibilityRole="alert" style={{ ...font(t, "sans", 400, 12.5, t.base.lineHeight / t.base.size), color: t.editor ? t.c.bad : t.c.badText }}>
              That is not a pairing link. Pairing links start with <T style={{ ...font(t, "mono", 500, 12, 1.4), color: t.editor ? t.c.bad : t.c.badText }}>remote.ue-mcp.com/pair</T>.
            </T>
          ) : null}
        </Panel>
      ) : null}
    </Page>
  );
}

/** .approval: the code both screens show, as Studio's approval card sets it, and what to do with it. */
export function ApprovalCode({ code }: { code: string }) {
  const t = useTheme();
  return (
    <View style={{ alignSelf: "stretch", gap: 8, paddingVertical: 12, paddingHorizontal: 14, borderWidth: 1, borderColor: t.c.accentLine, borderRadius: t.radiusLg, backgroundColor: t.c.accentWash }}>
      <View accessibilityRole="text" accessibilityLabel={`Code ${code.split("").join(" ")}`} style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
        <T style={{ ...font(t, "sans", 400, 14, 1.55), color: t.c.text }}>Code</T>
        <T style={{ ...font(t, "mono", 600, 22, 1.2), letterSpacing: 1.32, color: t.c.text }}>{formatPairingCode(code)}</T>
      </View>
      <T style={{ ...font(t, "sans", 400, 12, t.base.lineHeight / t.base.size), color: t.c.muted }}>
        Allow it only if your computer shows the same code. If it is different, choose <T style={{ ...font(t, "sans", 600, 12), color: t.c.text }}>Deny</T> there.
      </T>
    </View>
  );
}

/** Under way: the phone proving itself, then the code to compare while the owner decides. */
export function Pairing({ step }: { step: PairStep }) {
  if (step.kind === "code")
    return (
      <Page stage>
        <StateView glyph="lock" title="Allow this phone on your computer" lead="Studio on your computer asks whether to allow this phone. Allow it there within 2 minutes.">
          <ApprovalCode code={step.code} />
          <Waiting>Waiting for your computer</Waiting>
        </StateView>
      </Page>
    );
  return (
    <Page stage>
      <StateView glyph="lock" title="Pairing with your computer" lead="This phone is proving itself to your computer. It takes a few seconds.">
        <Waiting>{step.text}</Waiting>
      </StateView>
    </Page>
  );
}

/** Allowed: a moment on the tick before the projects open. */
export function Paired() {
  return (
    <Page stage>
      <StateView glyph="done" title="Paired" lead="This phone can now open Studio for every project on that computer.">
        <Waiting>Opening your projects</Waiting>
      </StateView>
    </Page>
  );
}

export interface PairFailure {
  kind: PairFailureKind;
  message: string;
}

/** What each failure is called, what happened, and what to do, in the relay's words for a phone. */
function wording(f: PairFailure): { head: string; text: string; note: string } {
  switch (f.kind) {
    case "bad-link":
      return { head: "This is not a pairing code", text: "The code or link was cut short, or it is not a UE-MCP Studio pairing code.", note: NEW_CODE };
    case "denied":
      return { head: "Pairing did not finish", text: "The computer's owner denied this phone.", note: NEW_CODE };
    case "offline":
      return { head: "Your computer went offline", text: "It stopped answering while this phone was pairing.", note: "Check that Studio is running with Remote control on, then make a new code." };
    case "network":
      return { head: "The relay could not be reached", text: "Either this phone is offline or the relay is down.", note: "Check the connection, then try again." };
    case "plan":
      return { head: "Remote control is not available", text: "This account's plan does not include remote control.", note: `It comes with ${REMOTE_PLANS}. Upgrade the account in Studio on your computer, then make a new code there.` };
    case "mismatch":
      return { head: "The codes did not match", text: "This phone was not paired.", note: NEW_CODE };
    default:
      // The relay's and the computer's words often end on the same advice the note gives.
      return { head: "Pairing did not finish", text: f.message.replace(/\s*Make a new (code|one)[^.]*\.\s*$/i, "") || f.message, note: NEW_CODE };
  }
}

/**
 * Pairing stopped. A code that ran out or went unanswered is a state, as the
 * relay draws it; everything else is the error panel with what happened.
 */
export function PairFailed({ failure, onScan, onStart, onRetry }: { failure: PairFailure; onScan: () => void; onStart: () => void; onRetry?: () => void }) {
  // Every stopped pairing ends on the same two actions in the same order: the way on, then back to the start.
  // Scanning again cannot help an account without the plan: there Start over is the only way.
  const way =
    failure.kind === "plan" ? null : failure.kind === "network" && onRetry ? <Button title="Try again" variant="primary" size="large" onPress={onRetry} /> : <Button title="Scan a new code" variant="primary" size="large" onPress={onScan} />;
  const actions = (
    <View style={{ flex: 1, gap: 8 }}>
      {way}
      <Button title="Start over" size="large" onPress={onStart} />
    </View>
  );
  if (failure.kind === "expired" || failure.kind === "timeout")
    return (
      <Page stage>
        <StateView
          glyph="expired"
          title={failure.kind === "expired" ? "This code no longer works" : "No one allowed this phone in time"}
          lead={failure.kind === "expired" ? `Each code works once, for ten minutes. ${NEW_CODE}` : `Studio waits two minutes for an answer. ${NEW_CODE}`}
          actions={actions}
        />
      </Page>
    );
  const w = wording(failure);
  return (
    <Page stage>
      <Panel bad head={w.head} text={w.text} note={w.note} actions={actions} />
    </Page>
  );
}
