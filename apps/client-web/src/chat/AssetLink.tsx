import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../api";
import { native } from "../native";
import { splitText, useAssetLink } from "./asset-links";

/** How long the inline note after a click stays up. */
export const TOAST_MS = 2500;

/** Open one asset in the editor, then bring the editor forward where the window can. */
export async function openInEditor(path: string): Promise<string | null> {
  try {
    await api.openAsset(path);
  } catch (e) {
    return e instanceof ApiError ? e.message : "Studio not reachable";
  }
  // Studio's own window raises the editor without taking focus; elsewhere there is nothing to call.
  void native().raiseeditor?.().catch(() => false);
  return null;
}

/**
 * A markdown link from the model to an object path: exact, never looked up.
 * It reads as the short name in code style, the full path in its tooltip.
 */
export function ExactAssetLink({ path, label }: { path: string; label: string }) {
  return <AssetButton token={label} code paths={[path]} />;
}

/**
 * A token that may name an asset: plain until the agent resolves it, then a
 * link that opens it. A name still ambiguous after the session trace and the
 * project lookup opens a small chooser; that is a miss, reported to the log.
 */
export function AssetToken({ token, code }: { token: string; code: boolean }) {
  const state = useAssetLink(token);
  const plain: ReactNode = code ? <code>{token}</code> : token;
  if (state.status !== "resolved") return <>{plain}</>;
  return <AssetButton token={token} code={code} paths={state.paths} />;
}

function AssetButton({ token, code, paths }: { token: string; code: boolean; paths: string[] }) {
  const [toast, setToast] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const box = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (!choosing) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setChoosing(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setChoosing(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [choosing]);

  const several = paths.length > 1;
  useEffect(() => {
    if (several) void api.reportAssetMiss(token, paths.length).catch(() => {});
  }, [several, token, paths.length]);

  const open = async (path: string) => {
    setChoosing(false);
    const error = await openInEditor(path);
    if (error) setToast(error);
  };
  return (
    <span className="asset-ref" ref={box}>
      <button
        type="button"
        className={`asset-link${code ? " code" : ""}`}
        title={several ? `${paths.length} assets named ${token}:\n${paths.join("\n")}` : paths[0]}
        aria-haspopup={several ? "menu" : undefined}
        aria-expanded={several ? choosing : undefined}
        onClick={() => (several ? setChoosing(!choosing) : void open(paths[0]))}
      >
        {token}
      </button>
      {choosing && (
        <span className="asset-chooser" role="menu">
          {paths.map((p) => (
            <button key={p} type="button" role="menuitem" title={p} onClick={() => void open(p)}>{p}</button>
          ))}
        </span>
      )}
      {toast && <span className="asset-toast" role="status">{toast}</span>}
    </span>
  );
}

/** Plain text (a tool's input or result) with its object paths as asset links. */
export function LinkedText({ text }: { text: string }) {
  return <>{splitText(text).map((p, i) => (p.asset ? <AssetToken key={i} token={p.text} code={false} /> : p.text))}</>;
}
