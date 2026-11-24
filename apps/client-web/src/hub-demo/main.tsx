/**
 * The Playtest Hub demo: the real Studio UI against a simulated daemon in the
 * page (sim.ts), with a living project to try the hub on without an editor.
 * Opened as /ui/hub-demo.html (npm run hub-demo). Every write the page makes
 * changes the simulated project, which is kept in this browser's storage per
 * project until Reset. ?seed=full|empty|fresh picks the project, ?reset=1
 * starts it over.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-700.css";
import "../styles.css";
import "../settings.css";
import type { StudioSettings, StudioSettingsUpdate, StudioTheme } from "@ue-mcp-studio/shared";
import { daemonFor } from "../visual-qa/daemon";
import { DEMO_PROJECT, DEMO_PROJECT_DIR, DEMO_SEEDS, demoState, type DemoSeed, type DemoState } from "./seed";
import { HubDemo } from "./sim";
import { Toolbar } from "./Toolbar";
import { DemoViewport, installSimulatedPeer } from "./feed";

const params = new URLSearchParams(location.search);
const seed: DemoSeed = DEMO_SEEDS.includes(params.get("seed") as DemoSeed) ? (params.get("seed") as DemoSeed) : "full";
const STATE_KEY = `studio.hub-demo.state.${seed}`;
const SETTINGS_KEY = "studio.hub-demo.settings";

const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Storage blocked or full: the project lives for this page only.
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing kept to remove.
    }
  },
};

if (params.has("reset")) {
  storage.remove(STATE_KEY);
  params.delete("reset");
  const q = params.toString();
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
}
if (!location.hash || location.hash === "#" || location.hash === "#/") history.replaceState(null, "", `${location.pathname}${location.search}#/playtests`);

function loadState(): DemoState {
  const kept = storage.get(STATE_KEY);
  if (kept) {
    try {
      const s = JSON.parse(kept) as DemoState;
      if (s.version === 4 && s.seed === seed) return s;
    } catch {
      // Unreadable: start the project over.
    }
  }
  return demoState(seed);
}

// ---------- The event stream ----------

const encoder = new TextEncoder();
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let eventId = 0;
function publish(type: string, data: Record<string, unknown>): void {
  eventId += 1;
  const chunk = encoder.encode(`id: ${eventId}\nevent: ${type}\ndata: ${JSON.stringify({ at: new Date().toISOString(), ...data })}\n\n`);
  for (const c of streams) {
    try {
      c.enqueue(chunk);
    } catch {
      streams.delete(c);
    }
  }
}

const demo = new HubDemo(loadState(), { emit: publish });
// Play In Editor runs while the simulated project plays a run; its video is a canvas, through a stand-in peer.
const viewport = new DemoViewport({ playing: () => demo.state.live !== null, editor: () => demo.state.editor, emit: publish });
installSimulatedPeer();
const save = () => {
  if (!demo.dirty) return;
  demo.dirty = false;
  storage.set(STATE_KEY, JSON.stringify(demo.state));
};
setInterval(() => {
  demo.tick();
  viewport.tick();
}, 200);
setInterval(save, 1000);
window.addEventListener("pagehide", save);

// ---------- The rest of the daemon ----------

const keptSettings = (() => {
  try {
    return JSON.parse(storage.get(SETTINGS_KEY) ?? "{}") as Partial<StudioSettings>;
  } catch {
    return {};
  }
})();
const base = daemonFor(
  { title: "Playtest Hub demo", hash: "#/playtests", index: { playtests: [], listed: true }, settings: { ...keptSettings, experiments: { playtestHub: true } } },
  (keptSettings.theme ?? "ue-mcp") as StudioTheme,
);
const settings = base.settings;
const startedAt = new Date().toISOString();

function updateSettings(u: StudioSettingsUpdate): StudioSettings {
  const { experiments, usage, approvals, keys: _keys, signOut: _signOut, ...rest } = u;
  Object.assign(settings, rest);
  if (experiments) settings.experiments = { playtestHub: true, ...settings.experiments, ...experiments };
  if (usage) settings.usage = { ...settings.usage, ...usage };
  if (approvals) settings.approvals = { ...settings.approvals, ...approvals };
  const { theme, composerHeight, reviewTurns, askBeforeChanges, effort, model, experiments: exp } = settings;
  storage.set(SETTINGS_KEY, JSON.stringify({ theme, composerHeight, reviewTurns, askBeforeChanges, effort, model, experiments: exp }));
  return settings;
}

const health = () => ({
  ...base.health,
  projectRoot: DEMO_PROJECT_DIR.toLowerCase(),
  startedAt,
  lastEventId: eventId,
  editors: [{ name: DEMO_PROJECT, connected: demo.state.editor, port: 9877, pid: demo.state.editor ? 22816 : null, lastDisconnect: null }],
});

const json = (body: unknown, status = 200) =>
  status === 204 || body === undefined ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (!url.pathname.startsWith("/v1/")) return realFetch(input, init);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.pathname === "/v1/events") {
    let mine: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        mine = c;
        streams.add(c);
      },
      cancel() {
        if (mine) streams.delete(mine);
      },
    });
    init?.signal?.addEventListener("abort", () => {
      if (!mine) return;
      streams.delete(mine);
      try {
        mine.error(new DOMException("The stream was closed", "AbortError"));
      } catch {
        // Already closed.
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  let body: unknown;
  try {
    body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
  } catch {
    body = undefined;
  }
  const hub = demo.handle(method, url.pathname, url.searchParams, body);
  if (hub) return json(hub.body, hub.status);
  const seen = viewport.handle(method, url.pathname, url.searchParams, init?.signal);
  if (seen) {
    const a = await seen;
    return json(a.body, a.status);
  }
  if (url.pathname === "/v1/health") return json(health());
  if (url.pathname === "/v1/ext/studio/about") return json({ agentVersion: "demo", daemonVersion: base.health.version, uiVersion: "demo", projectDir: DEMO_PROJECT_DIR, name: `${DEMO_PROJECT} on DEV-PC` });
  if (url.pathname === "/v1/ext/studio/settings" && method === "PUT") return json(updateSettings((body ?? {}) as StudioSettingsUpdate));
  if (method === "GET") {
    const answer = base.answer("GET", url);
    return answer === undefined ? json({ error: `The demo daemon has no GET ${url.pathname}` }, 404) : json(answer);
  }
  return json({ error: "The demo daemon does not do this. Try it on the Playtests tab." }, 409);
};

// A docs or checkout link opens nothing in the demo.
window.open = () => null;

function reload(nextSeed: DemoSeed, reset: boolean): void {
  const q = new URLSearchParams(location.search);
  q.set("seed", nextSeed);
  if (reset) q.set("reset", "1");
  location.assign(`${location.pathname}?${q.toString()}#/playtests`);
}

const fontsLoaded = Promise.all([...document.fonts].map((f) => f.load().catch(() => undefined)));
void Promise.all([import("../App"), fontsLoaded]).then(([{ App }]) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

const bar = document.createElement("div");
bar.id = "hub-demo-toolbar";
document.body.appendChild(bar);
createRoot(bar).render(
  <Toolbar
    seed={seed}
    speed={demo.state.speed}
    editor={demo.state.editor}
    onSeed={(s) => {
      save();
      reload(s, false);
    }}
    onSpeed={(n) => demo.setSpeed(n)}
    onEditor={(c) => demo.setEditor(c)}
    onReset={() => {
      demo.dirty = false;
      storage.remove(STATE_KEY);
      reload(seed, true);
    }}
  />,
);
