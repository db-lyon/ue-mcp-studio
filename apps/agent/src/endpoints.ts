/**
 * Custom OpenAI-compatible endpoints: a name, a base URL, an optional key, and
 * the models it serves (read from its /models, or typed). Its models belong
 * to the vendor `endpoint:<id>`.
 *
 * Like the vendor keys, endpoints serve every project: the list is kept beside
 * the keys folder and each key in it, as `endpoint-<id>.key`, mode 600, never
 * returned by a route.
 *
 *   GET    /endpoints             every endpoint, keys by presence only
 *   POST   /endpoints             { name, baseUrl, key?, models? }: add one and read its models
 *   PUT    /endpoints/:id         change one; an empty key clears it
 *   DELETE /endpoints/:id         remove one and its key
 *   POST   /endpoints/:id/models  read its /models again
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { ENDPOINT_ID, type CustomEndpoint, type CustomEndpointInput, type EndpointModel } from "@ue-mcp-studio/shared";
import { globalKeysDir, readSecretFile, writeSecretFile } from "./settings.js";

interface Stored {
  id: string;
  name: string;
  baseUrl: string;
  models: EndpointModel[];
  listedAt: string | null;
  listError: string | null;
}

/** Models an endpoint lists that cannot hold a conversation. */
const NOT_CHAT = /(embed|whisper|tts|transcribe|moderation|rerank)/i;

/** The base URL as stored: http(s), no trailing slash. Throws when it is not one. */
export function baseUrlOf(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new Error("baseUrl is required");
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new Error("baseUrl must be an http or https URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("baseUrl must be an http or https URL");
  return u.toString().replace(/\/+$/, "");
}

/** A model list from the user: ids trimmed and unique. Throws on one that is not valid. */
export function modelsOf(v: unknown): EndpointModel[] {
  if (!Array.isArray(v)) throw new Error("models must be a list");
  const out: EndpointModel[] = [];
  v.forEach((m, i) => {
    const x = (m ?? {}) as Record<string, unknown>;
    const id = typeof x.id === "string" ? x.id.trim() : "";
    if (!id) throw new Error(`model ${i + 1} needs an id`);
    if (out.some((o) => o.id === id)) return;
    const model: EndpointModel = { id, ...(x.typed === true ? { typed: true } : {}) };
    out.push(model);
  });
  return out;
}

/** The chat models an endpoint's /models lists, by id. */
export async function listEndpointModels(baseUrl: string, key: string | null, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchImpl(`${baseUrl}/models`, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`its /models answered ${res.status}`);
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: unknown }> } | null;
  if (!body || !Array.isArray(body.data)) throw new Error("its /models did not answer with a model list");
  return [...new Set(body.data.map((m) => (typeof m.id === "string" ? m.id : "")).filter((id) => id && !NOT_CHAT.test(id)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** The listed models with the typed ones kept. */
export function mergeListed(current: EndpointModel[], listed: string[]): EndpointModel[] {
  const out: EndpointModel[] = listed.map((id) => ({ id }));
  for (const m of current) if (m.typed && !listed.includes(m.id)) out.push(m);
  return out;
}

/** An id from a name: lowercase words joined by hyphens, unique among those taken. */
export function idFor(name: string, taken: (id: string) => boolean): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "endpoint";
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

export class EndpointStore {
  private readonly file: string;

  constructor(private readonly keysDir = globalKeysDir(), file?: string) {
    this.file = file ?? path.join(path.dirname(keysDir), "endpoints.json");
  }

  private read(): Stored[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, "utf-8")) as { endpoints?: unknown };
      if (!Array.isArray(v.endpoints)) return [];
      return (v.endpoints as Stored[]).filter((e) => e && ENDPOINT_ID.test(e.id) && typeof e.baseUrl === "string").map((e) => ({
        id: e.id,
        name: typeof e.name === "string" && e.name ? e.name : e.id,
        baseUrl: e.baseUrl,
        models: (() => {
          try {
            return modelsOf(e.models ?? []);
          } catch {
            return [];
          }
        })(),
        listedAt: typeof e.listedAt === "string" ? e.listedAt : null,
        listError: typeof e.listError === "string" ? e.listError : null,
      }));
    } catch {
      return [];
    }
  }

  private write(list: Stored[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ endpoints: list }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  private keyFile(id: string): string {
    return path.join(this.keysDir, `endpoint-${id}.key`);
  }

  private view(e: Stored): CustomEndpoint {
    return { ...e, hasKey: this.key(e.id) !== null };
  }

  list(): CustomEndpoint[] {
    return this.read().map((e) => this.view(e));
  }

  get(id: string): CustomEndpoint | null {
    const e = this.read().find((x) => x.id === id);
    return e ? this.view(e) : null;
  }

  /** For the provider only. */
  key(id: string): string | null {
    return readSecretFile(this.keyFile(id));
  }

  private setKey(id: string, key: string): void {
    fs.mkdirSync(this.keysDir, { recursive: true });
    writeSecretFile(this.keyFile(id), key.trim());
  }

  create(input: CustomEndpointInput): CustomEndpoint {
    const list = this.read();
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) throw new Error("name is required");
    if (list.some((e) => e.name.toLowerCase() === name.toLowerCase())) throw new Error(`an endpoint is already named ${name}`);
    const e: Stored = {
      id: idFor(name, (id) => list.some((x) => x.id === id)),
      name,
      baseUrl: baseUrlOf(input.baseUrl),
      models: input.models === undefined ? [] : modelsOf(input.models).map((m) => ({ ...m, typed: true })),
      listedAt: null,
      listError: null,
    };
    if (input.key !== undefined && typeof input.key !== "string") throw new Error("key must be a string");
    this.write([...list, e]);
    if (input.key) this.setKey(e.id, input.key);
    return this.view(e);
  }

  update(id: string, input: CustomEndpointInput): CustomEndpoint {
    const list = this.read();
    const e = list.find((x) => x.id === id);
    if (!e) throw new NotFound(id);
    if (input.name !== undefined) {
      const name = typeof input.name === "string" ? input.name.trim() : "";
      if (!name) throw new Error("name must not be empty");
      if (list.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`an endpoint is already named ${name}`);
      e.name = name;
    }
    if (input.baseUrl !== undefined) {
      const url = baseUrlOf(input.baseUrl);
      // Another server's models are not this one's.
      if (url !== e.baseUrl) {
        e.models = e.models.filter((m) => m.typed);
        e.listedAt = null;
        e.listError = null;
      }
      e.baseUrl = url;
    }
    if (input.models !== undefined) {
      const given = modelsOf(input.models);
      const listed = new Set(e.models.filter((m) => !m.typed).map((m) => m.id));
      e.models = given.map((m) => (listed.has(m.id) ? { id: m.id } : { ...m, typed: true }));
    }
    if (input.key !== undefined && typeof input.key !== "string") throw new Error("key must be a string");
    this.write(list);
    if (input.key !== undefined) this.setKey(id, input.key);
    return this.view(e);
  }

  remove(id: string): boolean {
    const list = this.read();
    if (!list.some((e) => e.id === id)) return false;
    this.write(list.filter((e) => e.id !== id));
    writeSecretFile(this.keyFile(id), "");
    return true;
  }

  /** Read an endpoint's /models again and keep what it lists beside the typed models. A failure is kept to show, not thrown. */
  async refresh(id: string, fetchImpl: typeof fetch = fetch): Promise<CustomEndpoint> {
    const before = this.read().find((x) => x.id === id);
    if (!before) throw new NotFound(id);
    let listed: string[] | null = null;
    let error: string | null = null;
    try {
      listed = await listEndpointModels(before.baseUrl, this.key(id), fetchImpl);
    } catch (e) {
      error = e instanceof Error ? (e.name === "TimeoutError" ? "its /models did not answer within 10 seconds" : e.message) : String(e);
    }
    // Written against the list as it is now, so a change made while the request ran is kept.
    const list = this.read();
    const e = list.find((x) => x.id === id);
    if (!e) throw new NotFound(id);
    if (listed) e.models = mergeListed(e.models, listed);
    e.listedAt = new Date().toISOString();
    e.listError = error;
    this.write(list);
    return this.view(e);
  }
}

export class NotFound extends Error {
  constructor(id: string) {
    super(`no endpoint ${id}`);
  }
}


export interface EndpointRouteOptions {
  store: EndpointStore;
  /** After any change: the pickers and Models & accounts read again. */
  changed: () => void;
  /** After an endpoint is removed, so a model selected on it can be let go. */
  removed: (id: string) => void;
  fetch?: typeof fetch;
}

export function registerEndpointRoutes(api: DaemonExtensionApi, o: EndpointRouteOptions): void {
  const fail = (e: unknown) => (e instanceof NotFound ? { status: 404, body: { error: e.message } } : { status: 400, body: { error: e instanceof Error ? e.message : String(e) } });
  const body = (req: { body?: unknown }) => (req.body ?? {}) as CustomEndpointInput;

  api.route("GET", "/endpoints", () => ({ body: { endpoints: o.store.list() } }));

  api.route("POST", "/endpoints", async (req) => {
    try {
      const e = o.store.create(body(req));
      const listed = await o.store.refresh(e.id, o.fetch);
      o.changed();
      return { status: 201, body: listed };
    } catch (e) {
      return fail(e);
    }
  });

  api.route("PUT", "/endpoints/:id", async (req) => {
    try {
      const before = o.store.get(req.params.id);
      const input = body(req);
      let e = o.store.update(req.params.id, input);
      // A new address or key may list other models.
      if (before && ((input.baseUrl !== undefined && e.baseUrl !== before.baseUrl) || input.key !== undefined)) e = await o.store.refresh(e.id, o.fetch);
      o.changed();
      return { body: e };
    } catch (e) {
      return fail(e);
    }
  });

  api.route("DELETE", "/endpoints/:id", (req) => {
    if (!o.store.remove(req.params.id)) return { status: 404, body: { error: `no endpoint ${req.params.id}` } };
    o.removed(req.params.id);
    o.changed();
    return { status: 204 };
  });

  api.route("POST", "/endpoints/:id/models", async (req) => {
    try {
      const e = await o.store.refresh(req.params.id, o.fetch);
      o.changed();
      return { body: e };
    } catch (e) {
      return fail(e);
    }
  });
}
