/**
 * Unreal asset names in chat text: which tokens may name an asset, and the
 * routes that resolve and open them (POST /v1/ext/studio/assets/resolve and
 * /assets/open). The UI and the agent classify with the same rules, so the
 * agent never looks up a token the UI would not have sent.
 */

/** Mount roots that hold no openable assets. */
const NOT_ASSET_ROOTS = new Set(["Script", "Temp", "Memory", "Config"]);

/**
 * A full object path: /Root/Dir/Name, optionally .Object and :Sub. The root
 * starts upper case and is longer than one letter, so /C/Users and /usr/bin
 * are not taken for one.
 */
const OBJECT_PATH = /^\/([A-Z][A-Za-z0-9_]+)((?:\/[A-Za-z0-9_][A-Za-z0-9_-]*)+)(?:\.([A-Za-z0-9_]+))?(?::([A-Za-z0-9_.]+))?$/;

/** Object paths inside running text. Spaces end a path there. */
export const OBJECT_PATH_IN_TEXT = /(?<![\w/.:\\-])\/[A-Z][A-Za-z0-9_]+(?:\/[A-Za-z0-9_][A-Za-z0-9_-]*)+(?:\.[A-Za-z0-9_]+)?(?::[A-Za-z0-9_.]+)?/g;

/** Asset-style prefix names: SG_PlaceAssembly, BP_Player, M_Rock_01. */
const PREFIXED = /^[A-Z][A-Za-z0-9]{0,5}_[A-Za-z0-9_]*[A-Za-z0-9]$/;
/** CamelCase with at least two humps: PlaceAssembly. */
const CAMEL = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/;
/** Common asset name prefixes, for names written all in capitals. */
const ASSET_PREFIXES = new Set(["BP", "ABP", "WBP", "SM", "SK", "M", "MI", "MF", "T", "NS", "SG", "DA", "DT", "PCG", "LS", "L", "SFX", "S", "A", "CR", "IA", "IMC", "AM", "BS", "PA", "PHYS"]);
/** Unreal type names (AActor, FVector, UObject, TArray, SWidget, EMode, IFace). */
const TYPE_NAME = /^[UAFTSEI][A-Z][a-z]/;

export type AssetToken = { kind: "path"; path: string; packagePath: string; name: string } | { kind: "name"; name: string };

/** What a token names, or null when it does not look like an asset. */
export function classifyAssetToken(raw: string): AssetToken | null {
  const token = raw.trim();
  if (!token || token.length > 256 || /\s/.test(token)) return null;
  if (token.startsWith("/")) {
    const m = OBJECT_PATH.exec(token);
    if (!m) return null;
    const root = m[1];
    const dirs = m[2];
    if (NOT_ASSET_ROOTS.has(root)) return null;
    const leaf = dirs.slice(dirs.lastIndexOf("/") + 1);
    // A lower-case suffix is a file extension (.uasset, .json), not an object name.
    if (m[3] !== undefined && m[3] === m[3].toLowerCase()) return null;
    if (m[3] !== undefined && m[3] !== leaf) return null;
    return { kind: "path", path: token, packagePath: `/${root}${dirs}`, name: leaf };
  }
  if (token.length < 3 || token.length > 64 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return null;
  // No lower case at all is a constant or a macro (MAX_SIZE, UE_LOG), unless it has an asset prefix (BP_AI).
  if (!/[a-z]/.test(token) && !ASSET_PREFIXES.has(token.slice(0, token.indexOf("_")))) return null;
  if (PREFIXED.test(token)) return { kind: "name", name: token };
  if (CAMEL.test(token) && token.length >= 6 && !TYPE_NAME.test(token)) return { kind: "name", name: token };
  return null;
}

/** The object path an editor opens for a package path: /Game/A/B is /Game/A/B.B. */
export function objectPathOf(packagePath: string): string {
  const leaf = packagePath.slice(packagePath.lastIndexOf("/") + 1);
  return `${packagePath}.${leaf}`;
}

/** POST /v1/ext/studio/assets/resolve. sessionId lets the agent start from what that session already knows. */
export interface AssetResolveRequest {
  tokens: string[];
  sessionId?: string;
}

/**
 * resolved: one or more object paths. unresolved: no such asset, stays text.
 * retry: not answerable right now (the lookup failed or the batch was full); ask again later.
 */
export type AssetResolution =
  | { status: "resolved"; paths: string[] }
  | { status: "unresolved" }
  | { status: "retry" };

export interface AssetResolveResponse {
  results: Record<string, AssetResolution>;
}

/** POST /v1/ext/studio/assets/open. */
export interface AssetOpenRequest {
  path: string;
}

export interface AssetOpenResponse {
  path: string;
  alreadyOpen: boolean;
}

/** The most tokens one resolve request takes. */
export const MAX_RESOLVE_TOKENS = 64;
