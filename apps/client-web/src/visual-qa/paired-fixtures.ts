/**
 * States a paired browser reaches that the other fixtures leave out: the
 * feedback dialog and its answers, an update run followed from the computer,
 * Plugins empty, failing or older than the route, and Diagnostics filtered or
 * with the editor away. Shot with --remote as a paired browser sees them; the
 * mobile app is compared against the same shots.
 */
import type { Scenario } from "./fixtures";

const page = (title: string, hash: string, o: Partial<Scenario> = {}): Scenario => ({ title, hash, index: { playtests: [], listed: true }, ...o });

const ENVIRONMENT = "Studio 0.1.25-beta.30\nue-mcp 1.4.11-beta.4\nEditor plugin 0.1.7\nUnreal Engine 5.7\nWindows 11\nModel: Claude Sonnet 5.5 (Claude sign-in)";
const FEEDBACK_BUTTON = 'button[title="Report a problem or suggest an idea"]';
const OPEN_FEEDBACK = [".bar-menu-button", `.drawer-foot ${FEEDBACK_BUTTON}`];
const TITLE = "The model picker forgets my effort";
const DESCRIPTION = "I set effort to high, opened another session, and it was back to medium.";

/** The feedback dialog over Settings, the environment answered, typed and sent as given. */
function feedback(title: string, o: Partial<Scenario> & { send?: { status: number; body: unknown } } = {}): Scenario {
  const { send, ...rest } = o;
  return page(title, "#/settings", {
    get: (p) => (p === "/v1/ext/studio/feedback/environment" ? { body: ENVIRONMENT } : undefined),
    post: (p) => (p === "/v1/ext/studio/feedback" && send ? send : undefined),
    clicks: [FEEDBACK_BUTTON],
    narrowClicks: OPEN_FEEDBACK,
    ...rest,
  });
}

const TYPED = { types: [{ into: '.feedback input[aria-label="Title"]', text: TITLE }, { into: '.feedback textarea[aria-label="Description"]', text: DESCRIPTION }] };

/** An update the computer runs, as the paired browser follows it through studio.update.run. */
function updateRun(title: string, run: Record<string, unknown>): Scenario {
  return page(title, "#/settings", { events: [{ type: "studio.update.run", at: new Date().toISOString(), data: { run: { target: null, at: Date.now(), ...run } } }] });
}

const PLUGINS = [
  { name: "ue-mcp-meshy", version: "1.2.0", pinned: null, status: "ok", categories: ["meshy"], problems: [] },
  { name: "pie-studio", version: "0.4.1", pinned: "0.4.1", status: "ok", categories: ["qa"], problems: [] },
];
const CATALOG = [
  { slug: "meshy", name: "Meshy", packageName: "ue-mcp-meshy", tagline: "Generate meshes from text and images", category: "assets", tags: ["ai"], repoUrl: "https://github.com/db-lyon/ue-mcp-meshy", homepageUrl: "https://meshy.ai", readme: "# Meshy\n\nGenerate **static meshes** from a prompt or an image.\n\n- Text to mesh\n- Image to mesh\n\n```\nnpx ue-mcp plugin install meshy\n```" },
  { slug: "level-dresser", name: "Level Dresser", packageName: "ue-mcp-level-dresser", tagline: "Scatter props along splines and surfaces with rules", category: "levels" },
];
/** The registry's answer for plugins without a readme: an empty string beside the description. */
const CATALOG_NO_README = [
  { slug: "meshy", name: "Meshy", packageName: "ue-mcp-meshy", tagline: "Turn a prompt or image into a game-ready UE5 asset in one call.", description: "Generate a model with Meshy, then import via Interchange, apply Nanite and PBR setup, and place it in the level. Provisions a meshy tool category.", readme: "", category: "asset", repoUrl: "https://github.com/db-lyon/ue-mcp-meshy" },
  ...CATALOG.slice(1),
];

export const PAIRED_SCENARIOS: Record<string, Scenario> = {
  "feedback-remote": feedback("Send feedback from a paired browser: the kind, title and description, and the environment line"),
  "feedback-remote-filled": feedback("Send feedback typed in, with what gets added opened", { ...TYPED, afterType: { clicks: [".feedback details > summary"], wait: 400 } }),
  "feedback-remote-idea": feedback("Send feedback as an idea: the idea's placeholders", { clicks: [FEEDBACK_BUTTON, '.feedback-kind button[aria-checked="false"]'], narrowClicks: [...OPEN_FEEDBACK, '.feedback-kind button[aria-checked="false"]'] }),
  "feedback-remote-filed": feedback("Feedback sent and filed as an issue", { ...TYPED, afterType: { clicks: [".feedback button.primary"], wait: 600 }, send: { status: 200, body: { filed: true, url: "https://github.com/db-lyon/ue-mcp-studio/issues/321", number: 321 } } }),
  "feedback-remote-link": feedback("Feedback that could not be filed: it opens on GitHub to send from there", { ...TYPED, afterType: { clicks: [".feedback button.primary"], wait: 600 }, send: { status: 200, body: { filed: false, reason: "GitHub did not answer.", link: "https://github.com/db-lyon/ue-mcp-studio/issues/new" } } }),
  "feedback-remote-error": feedback("Feedback whose send failed: the error under the form", { ...TYPED, afterType: { clicks: [".feedback button.primary"], wait: 600 }, send: { status: 500, body: { error: "The feedback service could not be reached." } } }),
  "update-waiting-remote": updateRun("An update the computer keeps until the turn finishes, followed from a paired browser", { steps: [{ key: "ueMcp", state: "done" }, { key: "studio", state: "deferred" }], target: "1.4.11" }),
  "update-running-remote": updateRun("An update running on the computer, followed from a paired browser", { steps: [{ key: "ueMcp", state: "done" }, { key: "plugin", state: "active" }, { key: "studio", state: "pending" }], target: "1.4.11", detail: "Closing the editor" }),
  "update-failed-remote": updateRun("An update that stopped on the computer", { steps: [{ key: "ueMcp", state: "done" }, { key: "plugin", state: "failed" }, { key: "studio", state: "pending" }], target: "1.4.11", error: "The editor plugin is still 0.1.6; 0.1.7 did not install. Update tries again." }),
  "update-done-remote": updateRun("An update finished on the computer: what is installed now", { steps: [{ key: "ueMcp", state: "done" }, { key: "studio", state: "done" }], target: "1.4.11", summary: "Studio 0.1.25-beta.30, editor plugin 0.1.7, bridge plugin 1.4.11, ue-mcp 1.4.11." }),
  "plugins-remote-details": page("Plugins in a paired browser with a catalog entry's details open: its readme, Source and Homepage", "#/plugins", {
    get: (p) => (p === "/v1/plugins" ? { plugins: PLUGINS } : p === "/v1/plugins/catalog" ? { plugins: CATALOG } : undefined),
    clicks: [".plugin-card button.ghost"],
  }),
  "plugins-remote-details-description": page("Plugins in a paired browser with the details open on a catalog entry the registry sends with an empty readme: its description", "#/plugins", {
    get: (p) => (p === "/v1/plugins" ? { plugins: PLUGINS } : p === "/v1/plugins/catalog" ? { plugins: CATALOG_NO_README } : undefined),
    clicks: [".plugin-card button.ghost"],
  }),
  "plugins-remote-empty": page("Plugins in a paired browser with none installed and an empty catalog", "#/plugins", {
    get: (p) => (p === "/v1/plugins" ? { plugins: [] } : p === "/v1/plugins/catalog" ? { plugins: [] } : undefined),
  }),
  "plugins-remote-search": page("Plugins in a paired browser searched for something no plugin matches", "#/plugins", {
    get: (p) => (p === "/v1/plugins" ? { plugins: PLUGINS } : p === "/v1/plugins/catalog" ? { plugins: CATALOG } : undefined),
    type: { into: ".plugin-search", text: "voxel" },
  }),
  "plugins-remote-error": page("Plugins in a paired browser whose catalog could not be read", "#/plugins", {
    get: (p) => (p === "/v1/plugins" ? { plugins: PLUGINS } : undefined),
  }),
  "plugins-remote-unsupported": page("Plugins in a paired browser on a ue-mcp from before the plugins route", "#/plugins", { missing: ["/v1/plugins"] }),
  "settings-diagnostics-filtered": {
    ...page("Diagnostics with the event log filtered", "#/settings/diagnostics", { height: 2600 }),
    events: [
      { type: "editor.connected", at: new Date(Date.now() - 240_000).toISOString(), data: { project: "StudioE2E", port: 64666 } },
      { type: "studio.remote.available", at: new Date(Date.now() - 60_000).toISOString(), data: {} },
      { type: "client.attached", at: new Date(Date.now() - 30_000).toISOString(), data: { client: "studio-window", version: "0.1.25-beta.15" } },
    ],
    type: { into: '.log-top input[aria-label="Filter events"]', text: "remote" },
  },
  "settings-diagnostics-no-editor": page("Diagnostics with the editor closed: when and how it went, and Start", "#/settings/diagnostics", {
    height: 2600,
    get: (p) => (p === "/v1/health"
      ? { ok: true, pid: 4120, version: "1.4.11-beta.4", apiVersion: 1, projectRoot: "c:/projects/studioe2e", startedAt: "2026-11-04T08:00:00Z", editors: [{ name: "StudioE2E", connected: false, port: 64666, pid: null, lastDisconnect: { cause: "crashed", at: "2026-11-04T09:12:00Z" } }], clients: 0, inflight: 0, lastEventId: 0, extensions: [{ name: "studio", version: "0.1.25-beta.30" }], ui: null }
      : undefined),
  }),
};
