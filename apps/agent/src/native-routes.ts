/**
 * What each route loads from the vendors' own files, under /v1/ext/studio:
 *
 *   GET  /native                     per convention: instruction files, subagents and skills, with paths and sizes
 *   GET  /native/preview?convention= the instruction text an agent on that convention is given
 *   POST /files/open                 { path }: open a file the view listed in the system's editor
 *
 * Read only: Studio writes none of these files.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { CONVENTIONS, conventionOf, type Convention, type NativeOverview, type NativePreview, type NativeView, type WorkerView } from "@ue-mcp-studio/shared";
import { loadout, type Loadout } from "./native.js";
import { composeNative, modelOf, toolsFor } from "./native-runtime.js";

export interface NativeRouteOptions {
  /** "Read the project's own files". */
  enabled: () => boolean;
  /** The main agent's model, its vendor, and the route it runs on now (null: nothing runs it). */
  main: () => { vendor: string; model: string; route: string | null };
  /** The connected routes whose models are this vendor's, by name ("Claude sign-in", "OpenAI key"). */
  routesFor: (vendor: string) => string[];
  /** Whether a model runs here over the API (a key or a sign-in other than Claude's). */
  runsOverApi: (vendor: string, model: string) => boolean;
  /** A model's display name. */
  modelName: (model: string) => string;
  worker: () => WorkerView;
  home: () => string;
  owners: () => Map<string, string>;
  /** Where the walk up from the project stops; the filesystem root unless a test bounds it. */
  top?: string;
  /** Opens a file with the system's default app; replaced in tests. */
  open?: (abs: string) => void;
}

const VENDOR_OF: Record<Convention, string | null> = { claude: "anthropic", codex: "openai", gemini: "google", agents: null };

/** Opens a file in the system's default app for its type. */
export function openWithSystem(abs: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", abs]] : process.platform === "darwin" ? ["open", [abs]] : ["xdg-open", [abs]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** A tool list in Studio's words. */
function toolSummary(allowed: Set<string> | null, unknown: string[]): string {
  const names = allowed === null ? "every Studio tool (the file sets no limit)" : allowed.size ? [...allowed].join(", ") : "no tools";
  return unknown.length ? `${names}; not available here: ${unknown.join(", ")}` : names;
}

export function nativeView(l: Loadout, o: Pick<NativeRouteOptions, "routesFor" | "runsOverApi" | "modelName" | "main">): NativeView {
  const main = o.main();
  return {
    convention: l.convention,
    routes: VENDOR_OF[l.convention] ? o.routesFor(VENDOR_OF[l.convention]!) : o.routesFor("endpoint"),
    instructions: l.instructions.map(({ path: p, source, tokens, scope, imports }) => ({ path: p, source, tokens, scope, ...(imports ? { imports } : {}) })),
    instructionTokens: l.instructions.filter((f) => f.scope.kind === "always").reduce((n, f) => n + f.tokens, 0),
    subagents: l.subagents.map((a) => {
      const { allowed, unknown } = toolsFor(a);
      const wants = modelOf(l.convention, a.model);
      const runs = !wants
        ? { model: `The main agent's, ${o.modelName(main.model)}` }
        : o.runsOverApi(wants.vendor, wants.model)
          ? { model: o.modelName(wants.model) }
          : { model: `The main agent's, ${o.modelName(main.model)}`, note: `Nothing on this machine runs ${a.model} over the API, so it runs on the main agent's model.` };
      return {
        name: a.name,
        description: a.description,
        path: a.path,
        source: a.source,
        tokens: Math.ceil(a.prompt.length / 4),
        model: a.model,
        runs,
        tools: toolSummary(allowed, unknown),
        effort: a.effort,
        maxTurns: a.maxTurns,
        problems: a.problems,
      };
    }),
    skills: l.skills.map(({ name, description, path: p, source, owner, tokens, implicit, problems }) => ({ name, description, path: p, source, ...(owner ? { owner } : {}), tokens, implicit, problems })),
    notes: l.notes,
  };
}

export function registerNativeRoutes(api: DaemonExtensionApi, o: NativeRouteOptions): void {
  /** Every absolute path the last view listed: the only files Open file may open. */
  let listed = new Set<string>();
  const loadAll = (): Loadout[] => CONVENTIONS.map((c) => loadout(c, api.projectDir, o.home(), o.owners(), o.top));

  api.route("GET", "/native", () => {
    const all = loadAll();
    listed = new Set(all.flatMap((l) => [...l.instructions.map((f) => path.resolve(f.abs)), ...l.subagents.map((a) => path.resolve(a.abs)), ...l.skills.map((s) => path.resolve(s.abs, "SKILL.md"))]));
    const main = o.main();
    const body: NativeOverview = {
      enabled: o.enabled(),
      main: main.route ? conventionOf(main.vendor) : null,
      conventions: all.map((l) => nativeView(l, o)),
      worker: o.worker(),
    };
    return { body };
  });

  api.route("GET", "/native/preview", (req) => {
    const c = req.query.convention as Convention;
    if (!CONVENTIONS.includes(c)) return { status: 400, body: { error: `convention must be one of ${CONVENTIONS.join(", ")}` } };
    const l = loadout(c, api.projectDir, o.home(), o.owners(), o.top);
    const main = o.main();
    const sdk = c === "claude" && main.route === "claude";
    // On the Claude sign-in Studio adds no instruction text: the Agent SDK reads the files, so the preview is the files.
    const always = l.instructions.filter((f) => f.scope.kind === "always");
    const composed = composeNative(l);
    const text = sdk ? always.map((f) => `## ${f.path}\n${f.text}`).join("\n\n") : composed.text ?? "";
    const tokens = sdk ? always.reduce((n, f) => n + f.tokens, 0) : composed.tokens;
    const body: NativePreview = { convention: c, text, tokens, files: always.length, loadedBy: sdk ? "sdk" : "studio" };
    return { body };
  });

  api.route("POST", "/files/open", (req) => {
    const p = (req.body as { path?: unknown } | undefined)?.path;
    if (typeof p !== "string" || !p) return { status: 400, body: { error: "body must be { path: string }" } };
    if (listed.size === 0) loadAll().forEach((l) => [...l.instructions, ...l.subagents].forEach((f) => listed.add(path.resolve(f.abs))));
    const home = o.home();
    const abs = path.resolve(p.startsWith("~/") ? path.join(home, p.slice(2)) : path.isAbsolute(p) ? p : path.join(api.projectDir, p));
    const target = listed.has(abs) ? abs : listed.has(path.join(abs, "SKILL.md")) ? path.join(abs, "SKILL.md") : null;
    if (!target) return { status: 403, body: { error: "Only a file this page lists can be opened." } };
    (o.open ?? openWithSystem)(target);
    return { status: 204 };
  });
}
