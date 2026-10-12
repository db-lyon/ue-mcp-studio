/**
 * Asset names in the chat as links: which tokens are candidates, and the
 * store that resolves them through the agent.
 *
 * Candidates are inline code spans and bare object paths in a reply, never
 * fenced code. A reply renders as plain text first; the store asks the agent
 * in batches, one request at a time, and a token turns into a link when its
 * answer comes back. A token the agent could not answer yet (retry, or the
 * request failed) stays plain and is asked again later, backing off.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { api } from "../api";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { MAX_RESOLVE_TOKENS, OBJECT_PATH_IN_TEXT, classifyAssetToken, type AssetResolution } from "@ue-mcp-studio/shared";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
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
    if (child.type === "inlineCode") {
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
 * The remark plugin: marks inline code that names an asset (data-asset on the
 * code element) and wraps bare object paths in a span.asset-path. Fenced code
 * is left alone.
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

/** Bare object paths in plain text (a tool's input or result), split for linking. */
export function splitText(text: string, max = 50): Array<{ text: string; asset: boolean }> {
  const out: Array<{ text: string; asset: boolean }> = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(new RegExp(OBJECT_PATH_IN_TEXT.source, "g"))) {
    if (n >= max) break;
    if (!classifyAssetToken(m[0])) continue;
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), asset: false });
    out.push({ text: m[0], asset: true });
    last = at + m[0].length;
    n++;
  }
  if (last < text.length) out.push({ text: text.slice(last), asset: false });
  return out;
}

export type LinkState = { status: "pending" } | { status: "resolved"; paths: string[] } | { status: "unresolved" };

const PENDING: LinkState = { status: "pending" };

export type Resolve = (tokens: string[], sessionId: string | null) => Promise<Record<string, AssetResolution>>;

/** How long a token waits before it is asked again: grows with each try, to a minute. */
export const RETRY_MS = [3000, 10_000, 30_000, 60_000];

/** Resolutions for one session's view, asked in debounced batches, one request at a time. */
export class AssetLinks {
  private readonly states = new Map<string, LinkState>();
  private readonly tries = new Map<string, number>();
  private readonly queue = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight = false;
  private disposed = false;

  constructor(
    private readonly resolve: Resolve,
    private readonly sessionId: string | null,
    private readonly debounceMs = 120,
  ) {}

  /** The same object until the token's state changes, as useSyncExternalStore needs. */
  state(token: string): LinkState {
    return this.states.get(token) ?? PENDING;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Ask for a token the first time it shows; later asks are free. */
  request(token: string): void {
    if (this.states.has(token) || this.queue.has(token) || this.disposed) return;
    this.states.set(token, PENDING);
    this.enqueue(token, this.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private enqueue(token: string, delay: number): void {
    this.queue.add(token);
    this.schedule(delay);
  }

  private schedule(delay: number): void {
    if (this.timer || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private later(tokens: string[]): void {
    for (const t of tokens) {
      const n = this.tries.get(t) ?? 0;
      this.tries.set(t, n + 1);
      setTimeout(() => !this.disposed && this.enqueue(t, 0), RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
    }
  }

  private async flush(): Promise<void> {
    if (this.inflight || this.queue.size === 0 || this.disposed) return;
    const batch = [...this.queue].slice(0, MAX_RESOLVE_TOKENS);
    for (const t of batch) this.queue.delete(t);
    this.inflight = true;
    try {
      const results = await this.resolve(batch, this.sessionId);
      const again: string[] = [];
      for (const t of batch) {
        const r = results[t];
        if (!r || r.status === "retry") again.push(t);
        else this.states.set(t, r.status === "resolved" && r.paths.length ? { status: "resolved", paths: r.paths } : { status: "unresolved" });
      }
      this.later(again);
      this.emit();
    } catch {
      // The agent is unreachable or restarting: the tokens stay plain and are asked again.
      this.later(batch);
    } finally {
      this.inflight = false;
      if (this.queue.size) this.schedule(0);
    }
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** The open session's resolutions; null outside a session, where tokens stay plain. */
export const AssetLinksContext = createContext<AssetLinks | null>(null);

const noop = () => () => {};

/** One token's state, asked for on first render. */
export function useAssetLink(token: string): LinkState {
  const store = useContext(AssetLinksContext);
  useEffect(() => store?.request(token), [store, token]);
  return useSyncExternalStore(store ? store.subscribe : noop, () => (store ? store.state(token) : PENDING));
}

/** A store for the open session, asking the agent; replaced when the session changes. */
export function useAssetLinks(sessionId: string | null): AssetLinks {
  const store = useMemo(() => new AssetLinks(async (tokens, id) => (await api.resolveAssets(tokens, id)).results, sessionId), [sessionId]);
  useEffect(() => () => store.dispose(), [store]);
  return store;
}
