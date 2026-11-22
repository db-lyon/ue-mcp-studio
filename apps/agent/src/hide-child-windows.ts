/**
 * On Windows, a child process started from a process with no console gets a
 * console window of its own unless it is started with windowsHide. Studio's
 * daemon, durable harness and turn host all run without a console, so every
 * ripgrep, fd or shell a tool started flashed a terminal window and took focus
 * (Pi's grep, find and bash tools pass no windowsHide). This makes windowsHide
 * the default for every child_process call in the process, then syncs the ESM
 * named exports so code that imported `spawn` by name gets the hidden version.
 *
 * Injected first into every agent bundle (scripts/bundle-agent.mjs).
 */
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

type AnyFn = (...args: unknown[]) => unknown;

/** Returns args with windowsHide defaulted on in the options object, adding one where the call has none. */
export function withWindowsHide(args: unknown[], optionsIndex: (args: unknown[]) => number): unknown[] {
  const out = [...args];
  const i = optionsIndex(out);
  const current = out[i];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    if ((current as { windowsHide?: unknown }).windowsHide === undefined) out[i] = { ...(current as object), windowsHide: true };
  } else if (current === undefined || current === null) {
    out[i] = { windowsHide: true };
  } else {
    // A callback sits where the options would: put the options before it.
    out.splice(i, 0, { windowsHide: true });
  }
  return out;
}

// spawn/execFile/fork/spawnSync/execFileSync take (file, args?, options?, ...).
const afterArgs = (a: unknown[]): number => (Array.isArray(a[1]) ? 2 : 1);
// exec/execSync take (command, options?, callback?).
const second = (): number => 1;

const TARGETS: Array<[keyof typeof childProcess, (a: unknown[]) => number]> = [
  ["spawn", afterArgs],
  ["spawnSync", afterArgs],
  ["execFile", afterArgs],
  ["execFileSync", afterArgs],
  ["fork", afterArgs],
  ["exec", second],
  ["execSync", second],
];

const PATCHED = Symbol.for("ue-mcp-studio.windowsHide");

export function installWindowsHide(cp: typeof childProcess = childProcess): void {
  const mod = cp as unknown as Record<string | symbol, unknown>;
  if (mod[PATCHED]) return;
  for (const [name, index] of TARGETS) {
    const original = mod[name] as AnyFn | undefined;
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, withWindowsHide(args, index));
    };
    // exec and execFile carry a promisify.custom implementation; keep it working.
    for (const key of Reflect.ownKeys(original)) {
      if (key === "length" || key === "name" || key === "prototype") continue;
      const desc = Object.getOwnPropertyDescriptor(original, key);
      if (desc) Object.defineProperty(wrapped, key, desc);
    }
    mod[name] = wrapped;
  }
  mod[PATCHED] = true;
  syncBuiltinESMExports();
}

if (process.platform === "win32") installWindowsHide();
