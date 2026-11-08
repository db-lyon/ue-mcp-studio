/**
 * chat/asset-links.ts: the open session's asset link store and the contexts a
 * message reads it through. Which tokens are candidates and how the store
 * resolves them live in client-core, shared with the web client.
 */
import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { AssetLinks, LINK_PENDING, type LinkState } from "@ue-mcp-studio/client-core";
import { useProjectNav } from "../nav";

export { AssetLinks, RETRY_MS, splitText, stepParts, stepPlain, type LinkState, type Resolve, type StepPart } from "@ue-mcp-studio/client-core";

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
  const { api } = useProjectNav();
  const store = useMemo(() => new AssetLinks(async (refs, id) => (await api.resolveAssets(refs, id)).results, sessionId), [sessionId, api]);
  useEffect(() => () => store.dispose(), [store]);
  return store;
}
