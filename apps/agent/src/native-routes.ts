/**
 * What each route loads from the vendors' own files, under /v1/ext/studio:
 *
 *   GET  /native                     per convention: instruction files, subagents and skills, with paths and sizes
 *   GET  /native/preview?convention= the instruction text an agent on that convention is given
 *   GET  /files/read?path=&from=     a project file as text, for Studio's file viewer
 *   POST /files/open                 { path, from? }: open a text file in the system's editor
 *
 * Read only: Studio writes none of these files.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DaemonExtensionApi } from "ue-mcp/daemon";
import { CONVENTIONS, conventionOf, openableInEditor, type Convention, type NativeOverview, type NativePreview, type NativeView, type WorkerView } from "@ue-mcp-studio/shared";
import { loadout, type Loadout } from "./native.js";
import { composeNative, modelOf, toolsFor } from "./native-runtime.js";
import { readProjectFile, resolveProjectFile, type FileScope } from "./project-files.js";

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

/**
 * Opens a file in the system's default app for its type. On Windows the path
 * reaches Start-Process through the environment, so no shell parses it.
 */
export function openWithSystem(abs: string): void {
  const [cmd, args] = process.platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -LiteralPath $env:STUDIO_OPEN_PATH"]]
    : process.platform === "darwin" ? ["open", [abs]] : ["xdg-open", [abs]];
  spawn(cmd, args as string[], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, STUDIO_OPEN_PATH: abs } }).unref();
}

/** A tool list in Studio's words. */
function toolSummary(allowed: Set<string> | null, unknown: string[]): string {
  const names = allowed === null ? "every Studio tool (the file sets no limit)" : allowed.size ? [...allowed].join(", ") : "no tools";
  return unknown.length ? `${names}; no Studio tool does ${unknown.join(", ")}, so it is left out` : names;
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
      // With nothing that runs the main agent, no subagent runs either: say what it waits for, never a model.
      const runs = main.route === null
        ? wants && !o.runsOverApi(wants.vendor, wants.model)
          ? { model: "The main agent's model, once one is connected", note: `Nothing on this machine runs ${a.model} over the API, so it runs on the main agent's model.` }
          : wants
            ? { model: o.modelName(wants.model) }
            : { model: "The main agent's model, once one is connected" }
        : !wants
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
    skipped: l.skipped.map(({ path: p, why }) => ({ path: p, why })),
  };
}

export function registerNativeRoutes(api: DaemonExtensionApi, o: NativeRouteOptions): void {
  /** Every absolute path the last view listed: the only files Open file may open. */
  let listed = new Set<string>();
  const loadAll = (): Loadout[] => CONVENTIONS.map((c) => loadout(c, api.projectDir, o.home(), o.owners(), o.top));

  api.route("GET", "/native", () => {
    const all = loadAll();
    listed = new Set(all.flatMap((l) => [...l.instructions.map((f) => path.resolve(f.abs)), ...l.skipped.map((f) => path.resolve(f.abs)), ...l.subagents.map((a) => path.resolve(a.abs)), ...l.skills.map((s) => path.resolve(s.abs, "SKILL.md"))]));
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
    const body: NativePreview = { convention: c, text, tokens, files: always.length, loadedBy: sdk ? "sdk" : "studio", ...(sdk ? { parts: always.map((f) => ({ path: f.path, text: f.text })) } : {}) };
    return { body };
  });

  const scope = (): FileScope => ({
    projectDir: api.projectDir,
    home: o.home(),
    listed: () => {
      if (listed.size === 0) loadAll().forEach((l) => [...l.instructions, ...l.subagents].forEach((f) => listed.add(path.resolve(f.abs))));
      return listed;
    },
  });

  api.route("GET", "/files/read", (req) => readProjectFile(scope(), req.query.path, req.query.from));

  api.route("POST", "/files/open", (req) => {
    const b = req.body as { path?: unknown; from?: unknown } | undefined;
    if (typeof b?.path !== "string" || !b.path) return { status: 400, body: { error: "body must be { path: string, from?: string }" } };
    const r = resolveProjectFile(scope(), b.path, b.from);
    if (!r.ok) return { status: r.status, body: { error: r.error } };
    // The resolved name decides too: a .md link to a program is still a program.
    if (!fs.statSync(r.real).isFile() || !openableInEditor(r.abs) || !openableInEditor(r.real)) return { status: 403, body: { error: `Studio opens text files only, not ${r.shown}.` } };
    (o.open ?? openWithSystem)(r.real);
    return { status: 204 };
  });
}
