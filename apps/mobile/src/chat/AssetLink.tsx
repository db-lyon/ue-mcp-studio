/**
 * chat/AssetLink.tsx: asset names as links that open the asset in the editor
 * on the computer. Each is inline text, so it wraps with the line it is in.
 */
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { HttpError, type StudioApi } from "@ue-mcp-studio/client-core";
import { font, inlineCode, Sheet, T, useTheme } from "../ui";
import { useProjectNav } from "../nav";
import { breakable } from "./breakable";
import { splitText, stepParts, useAssetLink } from "./asset-links";

/** How long the inline note after a press stays up. */
export const TOAST_MS = 2500;

/** Open one asset in the editor. The error to show, or null. */
export async function openInEditor(api: StudioApi, path: string): Promise<string | null> {
  try {
    await api.openAsset(path);
    return null;
  } catch (e) {
    return e instanceof HttpError ? e.message : "Studio not reachable";
  }
}

/**
 * A markdown link from the model to an object path: exact, never looked up.
 * It reads as the short name in code style.
 */
export function ExactAssetLink({ path, label }: { path: string; label: string }) {
  return <AssetButton token={label} code paths={[path]} />;
}

/**
 * A token that may name an asset: plain until the agent resolves it, then a
 * link that opens it. A name still ambiguous after the session trace and the
 * project lookup opens a chooser; that is a miss, reported to the log.
 */
export function AssetToken({ token, code }: { token: string; code: boolean }) {
  const t = useTheme();
  const state = useAssetLink(token);
  if (state.status !== "resolved") return code ? <Text style={codeStyle(t)}>{breakable(token)}</Text> : <>{token}</>;
  return <AssetButton token={token} code={code} paths={state.paths} />;
}

/** `.md code` and `.asset-link.code`: the markdown's inline code, at the mono font's own line height. */
const codeStyle = inlineCode;

function AssetButton({ token, code, paths }: { token: string; code: boolean; paths: string[] }) {
  const t = useTheme();
  const { api } = useProjectNav();
  const [toast, setToast] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  const several = paths.length > 1;
  useEffect(() => {
    if (several) void api.reportAssetMiss(token, paths.length).catch(() => {});
  }, [several, token, paths.length, api]);

  const open = async (path: string) => {
    setChoosing(false);
    const error = await openInEditor(api, path);
    if (error) setToast(error);
  };
  // .asset-link.code: the code chip with an accent underline; otherwise accent-hi text, underlined in the accent line.
  const look = code
    ? { ...codeStyle(t), boxShadow: `inset 0 -1px 0 ${t.c.accentLine}` }
    : { color: t.c.accentHi, textDecorationLine: "underline" as const, textDecorationColor: t.c.accentLine };
  return (
    <>
      <Text
        accessibilityRole="link"
        accessibilityLabel={several ? `${paths.length} assets named ${token}` : paths[0]}
        accessibilityState={several ? { expanded: choosing } : undefined}
        style={look}
        onPress={() => (several ? setChoosing(true) : void open(paths[0]))}
      >
        {code ? breakable(token) : token}
      </Text>
      {toast ? (
        <Text accessibilityRole="alert" style={{ fontSize: 11, backgroundColor: t.c.panel2, color: t.c.text }}>
          {`  ${toast} `}
        </Text>
      ) : null}
      {several ? (
        <Sheet open={choosing} title={`${paths.length} assets named ${token}`} onClose={() => setChoosing(false)}>
          <View accessibilityRole="menu">
            {paths.map((p) => (
              <Pressable key={p} accessibilityRole="menuitem" accessibilityLabel={p} onPress={() => void open(p)} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", paddingHorizontal: 6, borderRadius: 4, backgroundColor: pressed ? t.c.accentWash : "transparent" })}>
                <T numberOfLines={1} style={{ ...font(t, "mono", 400, 12), color: t.c.text }}>{p}</T>
              </Pressable>
            ))}
          </View>
        </Sheet>
      ) : null}
    </>
  );
}

/** Plain text (a tool's input or result) with its object paths as asset links. */
export function LinkedText({ text }: { text: string }) {
  return <>{splitText(text).map((p, i) => (p.asset ? <AssetToken key={i} token={p.text} code={false} /> : <Fragment key={i}>{p.text}</Fragment>))}</>;
}

/** A playtest step's text, or a line quoting one, with its asset names linked as chat links them. */
export function StepText({ text }: { text: string }): ReactNode {
  const t = useTheme();
  return (
    <>
      {stepParts(text).map((p, i) =>
        p.kind === "exact" ? <ExactAssetLink key={i} path={p.path} label={p.label} />
          : p.kind === "asset" ? <AssetToken key={i} token={p.token} code={p.code} />
          : p.kind === "code" ? <Text key={i} style={codeStyle(t)}>{breakable(p.text)}</Text>
          : <Fragment key={i}>{p.text}</Fragment>,
      )}
    </>
  );
}
