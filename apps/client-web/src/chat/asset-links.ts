/**
 * Asset names in the chat as links: which tokens are candidates, and the
 * store that resolves them through the agent.
 *
 * A markdown link to an object path is exact: it links that path and is never
 * looked up. Other candidates are inline code spans and bare object paths in a
 * reply, never fenced code. A reply renders as plain text first; the store asks
 * the agent in batches, one request at a time, with the message's transcript
 * index so a name resolves by what the session did up to it. A token the agent
 * could not answer yet (retry, or the request failed) stays plain and is asked
 * again later, backing off.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../api";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { OBJECT_PATH_IN_TEXT, assetLinkTarget, classifyAssetToken } from "@ue-mcp-studio/shared";
import { AssetLinks, type LinkState } from "@ue-mcp-studio/client-core";

// The store and the step splitter live in client-core, shared with the mobile app.
export { AssetLinks, RETRY_MS, splitText, stepParts, stepPlain, type LinkState, type Resolve, type StepPart } from "@ue-mcp-studio/client-core";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  url?: string;
  data?: Record<string, unknown>;
}

/** The text a node shows. */
function textOf(node: MdNode): string {
  return node.value ?? (node.children ?? []).map(textOf).join("");
}

/**
 * A link whose target starts with one slash is never a web link: an asset's
 * object path becomes an exact asset link showing its text, anything else
 * stays its text.
 */
function rootedLink(node: MdNode): MdNode[] | null {
  const url = node.url ?? "";
  if (node.type !== "link" || !url.startsWith("/") || url.startsWith("//")) return null;
  const path = assetLinkTarget(url);
  if (!path) return node.children ?? [];
  const label = textOf(node).trim() || path.slice(path.lastIndexOf(".") + 1);
  return [{ type: "assetLink", data: { hName: "span", hProperties: { "data-asset-path": path, "data-asset-label": label } }, children: [{ type: "text", value: label }] }];
}

/** Node types whose text is never scanned for bare paths. */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference", "html", "definition"]);

/** Split one text node's value into text and asset-path spans. */
function splitPaths(value: string, found: (token: string) => void): MdNode[] | null {
  const parts: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(new RegExp(OBJECT_PATH_IN_TEXT.source, "g"))) {
    const token = m[0];
    if (!classifyAssetToken(token)) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push({ type: "text", value: value.slice(last, at) });
    parts.push({ type: "assetPath", data: { hName: "span", hProperties: { className: ["asset-path"], "data-asset": token } }, children: [{ type: "text", value: token }] });
    found(token);
    last = at + token.length;
  }
  if (parts.length === 0) return null;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

function walk(node: MdNode, found: (token: string) => void): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    const linked = rootedLink(child);
    if (linked) {
      next.push(...linked);
    } else if (child.type === "inlineCode") {
      const token = child.value ?? "";
      if (classifyAssetToken(token)) {
        child.data = { ...child.data, hProperties: { "data-asset": token.trim() } };
        found(token.trim());
      }
      next.push(child);
    } else if (child.type === "text" && child.value) {
      next.push(...(splitPaths(child.value, found) ?? [child]));
    } else {
      if (!OPAQUE.has(child.type)) walk(child, found);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * The remark plugin: turns markdown links to object paths into exact asset
 * links (a span with data-asset-path), marks inline code that names an asset
 * (data-asset on the code element) and wraps bare object paths in a
 * span.asset-path. Fenced code is left alone.
 */
export function remarkAssets(options: { found?: (token: string) => void } = {}) {
  return (tree: MdNode) => walk(tree, options.found ?? (() => {}));
}

/** The asset tokens a reply names, in order, once each. */
export function assetCandidates(markdown: string): string[] {
  const out: string[] = [];
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkAssets, { found: (t: string) => void (out.includes(t) || out.push(t)) });
  processor.runSync(processor.parse(markdown));
  return out;
}

const PENDING: LinkState = { status: "pending" };

/** The open session's resolutions; null outside a session, where tokens stay plain. */
export const AssetLinksContext = createContext<AssetLinks | null>(null);

const noop = () => () => {};

/** The session's transcript, so a reply knows its own index in it. */
export const AssetTranscriptContext = createContext<readonly unknown[] | null>(null);

/** The transcript index of the message being rendered, for tracing the names in it. */
export const AssetAnchorContext = createContext<number | undefined>(undefined);

/** One token's state, asked for on first render. */
export function useAssetLink(token: string): LinkState {
  const store = useContext(AssetLinksContext);
  const at = useContext(AssetAnchorContext);
  useEffect(() => store?.request(token, at), [store, token, at]);
  return useSyncExternalStore(store ? store.subscribe : noop, () => (store ? store.state(token, at) : PENDING));
}

/** A store for the open session, asking the agent; replaced when the session changes. */
export function useAssetLinks(sessionId: string | null): AssetLinks {
  const store = useMemo(() => new AssetLinks(async (refs, id) => (await api.resolveAssets(refs, id)).results, sessionId), [sessionId]);
  useEffect(() => () => store.dispose(), [store]);
  return store;
}

