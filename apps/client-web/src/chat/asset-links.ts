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
import { AssetLinks, LINK_PENDING, remarkReplyLinks, type LinkState } from "@ue-mcp-studio/client-core";

export { AssetLinks, RETRY_MS, splitText, stepParts, stepPlain, type LinkState, type Resolve, type StepPart } from "@ue-mcp-studio/client-core";

/** The asset tokens a reply names, in order, once each. */
export function assetCandidates(markdown: string): string[] {
  const out: string[] = [];
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkReplyLinks, { found: (t: string) => void (out.includes(t) || out.push(t)) });
  processor.runSync(processor.parse(markdown as never) as never);
  return out;
}

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
  return useSyncExternalStore(store ? store.subscribe : noop, () => (store ? store.state(token, at) : LINK_PENDING));
}

/** A store for the open session, asking the agent; replaced when the session changes. */
export function useAssetLinks(sessionId: string | null): AssetLinks {
  const store = useMemo(() => new AssetLinks(async (refs, id) => (await api.resolveAssets(refs, id)).results, sessionId), [sessionId]);
  useEffect(() => () => store.dispose(), [store]);
  return store;
}

