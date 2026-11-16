/**
 * The daemon's one door to pi-ai: Sign in with ChatGPT. The sign-in flow, the
 * refresh of its token and the lock around that refresh are pi-ai's (its
 * `openai` provider's OAuth, run through a Models collection over Studio's
 * credential store). Everything else pi-ai offers is reached from the durable
 * harness, through durable/pi.ts; this module imports nothing from Pi Durable.
 *
 * pi-ai loads its sign-in flows through a specifier a bundler cannot follow;
 * registerLazyOAuthFlows puts them in the daemon's bundle instead.
 */
import { createModels } from "@earendil-works/pi-ai";
import { registerLazyOAuthFlows } from "@earendil-works/pi-ai/lazy-oauth";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { AuthInteraction, Credential, CredentialStore } from "@earendil-works/pi-ai";

export type { AuthInteraction, Credential, CredentialStore };

/** pi-ai's provider id for OpenAI, under which its credential store keeps the ChatGPT sign-in. */
export const CHATGPT_PROVIDER = "openai";

export interface ChatGptOAuth {
  /** Run the browser sign-in; its credential is in the store when this resolves. */
  login(interaction: AuthInteraction, o: { deviceId: string; agentName: string }): Promise<Credential>;
  /** A current access token, refreshed under the store's lock when it is about to expire; undefined when not signed in with ChatGPT. */
  accessToken(signal?: AbortSignal): Promise<string | undefined>;
}

let flows = false;

export function chatgptOAuth(store: CredentialStore): ChatGptOAuth {
  if (!flows) {
    registerLazyOAuthFlows();
    flows = true;
  }
  const models = createModels({ credentials: store });
  models.setProvider(openaiProvider());
  return {
    login: (interaction, o) => models.login(CHATGPT_PROVIDER, "oauth", interaction, { getDeviceId: () => o.deviceId, agentName: o.agentName }),
    accessToken: async (signal) => {
      // An API key in the environment is not a ChatGPT sign-in: only a stored OAuth credential answers.
      if ((await store.read(CHATGPT_PROVIDER))?.type !== "oauth") return undefined;
      const a = await models.getAuth(CHATGPT_PROVIDER, signal ? { signal } : undefined);
      return a?.source === "OAuth" ? a.auth.apiKey : undefined;
    },
  };
}
