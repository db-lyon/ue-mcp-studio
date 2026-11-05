/**
 * A playtest step's text with its asset names linked, as the web client links
 * them: a markdown link to an object path is exact, a name or bare path is
 * asked of the agent and linked once it resolves. A tap opens the asset in
 * the editor on the computer; a name that matches several assets offers each.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Platform, Text, type TextStyle } from "react-native";
import { HttpError, stepParts } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../../nav";
import { font, monoNormal, useTheme } from "../../ui";
import { useAssetLink } from "../../chat/asset-links";
import { chooseFrom } from "./parts";
import { keyboardFocus } from "./StepPath";

// One store for every link: the session's, which the chat provides, or the project's on the Playtests page.
export { AssetLinksContext, useAssetLinks } from "../../chat/asset-links";

/** Opens one asset in the editor; says why when it cannot. */
function useOpen() {
  const { api } = useProjectNav();
  return (path: string) =>
    void api.openAsset(path).catch((e: unknown) => Alert.alert("Could not open the asset", e instanceof HttpError ? e.message : "Studio not reachable"));
}

function choose(paths: string[], open: (p: string) => void) {
  chooseFrom(`${paths.length} assets`, paths, (i) => open(paths[i]));
}

function Link({ token, code, paths, size }: { token: string; code: boolean; paths: string[]; size: number }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const open = useOpen();
  const several = paths.length > 1;
  // .asset-link:focus-visible: a hairline outline 1px out and the underline in the accent.
  const [ring, setRing] = useState(false);
  useEffect(() => {
    if (several) void api.reportAssetMiss(token, paths.length).catch(() => undefined);
  }, [api, several, token, paths.length]);
  // A code chip keeps the colour of the text around it; on the web build it takes its padding and underline as the web client draws them.
  // The web client's links are inline boxes: a long one takes its own line rather than breaking around the text.
  // A long one breaks anywhere inside its box (overflow-wrap: anywhere), never past the line.
  const box = Platform.OS === "web" ? ({ display: "inline-block", maxWidth: "100%", wordBreak: "break-word" } as unknown as TextStyle) : {};
  const focus = ring ? ({ outlineWidth: 1, outlineStyle: "solid", outlineColor: t.c.accentLine, outlineOffset: 1, ...(code ? {} : { textDecorationColor: t.c.accent }) } as unknown as TextStyle) : null;
  // .asset-link.code sets its font with the shorthand, so its line height is the font's own. A link is a button,
  // and the editor themes' button rule (400 12px/1.2 sans) outranks both link rules.
  const editorFont: TextStyle = t.editor ? font(t, "sans", 400, 12, 1.2) : {};
  const style: TextStyle = code
    ? { ...box, ...font(t, "mono", 400, 12), lineHeight: monoNormal(t, 12), ...editorFont, letterSpacing: t.editor ? 0 : 0.24, backgroundColor: t.c.panel2, borderRadius: 4, ...(Platform.OS === "web" ? ({ paddingHorizontal: 4, paddingVertical: 1, boxShadow: `inset 0 -1px 0 ${t.c.accentLine}` } as TextStyle) : {}) }
    : {
        ...box,
        ...editorFont,
        color: t.c.accentHi,
        textDecorationLine: "underline",
        textDecorationColor: t.c.accentLine,
        letterSpacing: t.editor ? 0 : 0.02 * size,
        // A button keeps the --radius its focus outline follows; the underline stands 2px off the text.
        borderRadius: t.radius,
        ...(Platform.OS === "web" ? ({ textUnderlineOffset: 2 } as TextStyle) : {}),
      };
  return (
    <Text
      accessibilityRole="link"
      accessibilityLabel={token}
      accessibilityHint={several ? `${paths.length} assets named ${token}` : paths[0]}
      onPress={() => (several ? choose(paths, open) : open(paths[0]))}
      // Focus reaches a pressable text on the web build only; Text's types do not list it.
      {...({ onFocus: (e: { target?: unknown }) => setRing(keyboardFocus(e)), onBlur: () => setRing(false) } as object)}
      style={[style, focus]}
    >
      {code && Platform.OS !== "web" ? ` ${token} ` : token}
    </Text>
  );
}

/** A token that may name an asset: plain until the agent resolves it. */
export function AssetToken({ token, code, size = 13.5 }: { token: string; code: boolean; size?: number }) {
  const t = useTheme();
  const state = useAssetLink(token);
  if (state.status !== "resolved") return code ? <Text style={{ ...font(t, "mono", 400, 12) }}>{token}</Text> : <>{token}</>;
  return <Link token={token} code={code} paths={state.paths} size={size} />;
}

/** A link from the model to an exact object path, shown by its short name in code style. */
export function ExactAssetLink({ path, label }: { path: string; label: string }) {
  return <Link token={label} code paths={[path]} size={12} />;
}

/** A step's text, or a line quoting one, inside a Text whose style it takes. */
export function StepText({ text, size = 13.5 }: { text: string; size?: number }) {
  const t = useTheme();
  const parts = useMemo(() => stepParts(text), [text]);
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "exact" ? <ExactAssetLink key={i} path={p.path} label={p.label} />
        : p.kind === "asset" ? <AssetToken key={i} token={p.token} code={p.code} size={size} />
        : p.kind === "code" ? <Text key={i} style={font(t, "mono", 400, 12)}>{p.text}</Text>
        : <Text key={i}>{p.text}</Text>,
      )}
    </>
  );
}
