import type { BaseContext } from "@ue-mcp-studio/extension-api";
import { ApiError } from "../api";
import { subscribeEvent } from "./events";

const bases = new Map<string, BaseContext>();

/** What every context carries for one extension: requests under /v1/ext/<ext>/ and the event feed. */
export function baseContext(ext: string): BaseContext {
  let base = bases.get(ext);
  if (!base) {
    base = {
      api: {
        async fetchJson<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
          if (/(^|[\\/])\.\.?([\\/]|$)/.test(path) || /%2e/i.test(path)) throw new Error(`path "${path}" leaves /v1/ext/${ext}/`);
          const res = await fetch(`/v1/ext/${encodeURIComponent(ext)}/${path.replace(/^\/+/, "")}`, {
            method: init.method ?? (init.body === undefined ? "GET" : "POST"),
            signal: init.signal,
            headers: init.body === undefined ? undefined : { "content-type": "application/json" },
            body: init.body === undefined ? undefined : JSON.stringify(init.body),
            credentials: "same-origin",
          });
          const text = await res.text();
          const parsed = text ? (JSON.parse(text) as unknown) : undefined;
          if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`);
          return parsed as T;
        },
      },
      events: { subscribe: subscribeEvent },
    };
    bases.set(ext, base);
  }
  return base;
}
