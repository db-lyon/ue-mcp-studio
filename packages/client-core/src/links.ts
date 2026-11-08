/**
 * What a markdown link in a reply points at, decided once for every client:
 * a web page opens outside Studio, an object path opens the asset, a project
 * file opens in Studio's file viewer, and anything else is plain text, so
 * no client ever draws a link that goes nowhere.
 */
import { OBJECT_PATH_IN_TEXT, assetLinkTarget, classifyAssetToken } from "@ue-mcp-studio/shared";

export type LinkTarget =
  | { kind: "web"; url: string }
  | { kind: "asset"; path: string }
  /** path: as written, with forward slashes; line: from a #L12 or :12 suffix. */
  | { kind: "file"; path: string; line?: number }
  | { kind: "none" };

const NONE: LinkTarget = { kind: "none" };
const WEB = /^(https?:\/\/[^/\s]|mailto:[^\s])/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const DRIVE = /^[a-z]:\//i;
const UNREAL_ROOT = /^\/[A-Z][A-Za-z0-9_]+\//;

/** A link target as exactly one kind. */
export function classifyLink(raw: string | null | undefined): LinkTarget {
  const url = (raw ?? "").trim();
  if (!url) return NONE;
  if (WEB.test(url)) return { kind: "web", url };
  if (/^file:/i.test(url)) return fileTarget(fileUrlPath(url));
  const slashed = url.replace(/\\/g, "/");
  // Another scheme (javascript:, vscode:) or a network path is never followed. Door.cpp:12 is a line, not a scheme.
  const bare = slashed.replace(/:\d+(?::\d+)?$/, "");
  if ((SCHEME.test(bare) && !DRIVE.test(bare)) || slashed.startsWith("//")) return NONE;
  if (url.startsWith("/")) {
    const asset = assetLinkTarget(url);
    if (asset) return { kind: "asset", path: asset };
    // Under an Unreal mount root (/Game, /Script) a path that names no asset is text, never a file.
    if (UNREAL_ROOT.test(url)) return NONE;
  }
  return fileTarget(slashed);
}

/** file:///C:/a, file://localhost/a, file:/C:/a and file:docs/a.md as paths; a file URL to another host is a network path. */
function fileUrlPath(url: string): string | null {
  const rest = url.replace(/\\/g, "/").replace(/^file:/i, "");
  const m = /^\/\/([^/]*)(\/.*)?$/.exec(rest);
  if (m && m[1] && m[1].toLowerCase() !== "localhost") return null;
  const p = m ? m[2] ?? "" : rest;
  return /^\/[a-z]:\//i.test(p) ? p.slice(1) : p;
}

function fileTarget(raw: string | null): LinkTarget {
  if (!raw) return NONE;
  let p = raw;
  let line: number | undefined;
  const hash = p.indexOf("#");
  if (hash >= 0) {
    line = lineOf(/^L(\d+)/i.exec(p.slice(hash + 1))?.[1]);
    p = p.slice(0, hash);
  }
  const query = p.indexOf("?");
  if (query >= 0) p = p.slice(0, query);
  const colon = /^(.*?[^:]):(\d+)(?::\d+)?$/.exec(p);
  if (colon && !/^[a-z]$/i.test(colon[1])) {
    line ??= lineOf(colon[2]);
    p = colon[1];
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    // A stray % is part of the name.
  }
  if (!p || /[\0-\x1f]/.test(p)) return NONE;
  return line ? { kind: "file", path: p, line } : { kind: "file", path: p };
}

const lineOf = (s: string | undefined): number | undefined => (s && Number(s) >= 1 ? Number(s) : undefined);

/**
 * A file link followed from inside a viewed file, resolved against that
 * file's folder. Absolute and ~/ paths stand as they are. The result has no
 * . or .. steps unless it climbs above the folder the shown path starts from.
 */
export function resolveFileLink(from: string | null | undefined, target: string): string {
  if (!from || isAbsoluteFile(target)) return normalizeFile(target);
  const dir = from.replace(/\\/g, "/").replace(/\/[^/]*$/, "");
  return normalizeFile(dir === from ? target : `${dir}/${target}`);
}

const isAbsoluteFile = (p: string): boolean => p.startsWith("/") || p.startsWith("~/") || p === "~" || DRIVE.test(p);

/** Forward slashes, with . steps dropped and .. steps folded where they can be. */
export function normalizeFile(p: string): string {
  const s = p.replace(/\\/g, "/");
  const lead = /^([a-z]:\/|\/|~\/)/i.exec(s)?.[0] ?? "";
  const out: string[] = [];
  for (const part of s.slice(lead.length).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length && out[out.length - 1] !== "..") out.pop();
    // Above a root there is nothing to climb to; above the home folder or a relative start there is.
    else if (part !== ".." || lead === "" || lead === "~/") out.push(part);
  }
  return lead + out.join("/");
}

export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  url?: string;
  data?: Record<string, unknown>;
}

/** The text a node shows. */
function textOf(node: MdNode): string {
  return node.value ?? (node.children ?? []).map(textOf).join("");
}

/**
 * A markdown link as its kind draws it: a web link stays a link (null), an
 * object path becomes an exact asset link showing its text, a file becomes a
 * file link around its own text, and anything else is its text alone.
 */
function classified(node: MdNode): MdNode[] | null {
  const target = classifyLink(node.url);
  switch (target.kind) {
    case "web":
      return null;
    case "asset": {
      const label = textOf(node).trim() || target.path.slice(target.path.lastIndexOf(".") + 1);
      return [{ type: "assetLink", data: { hName: "span", hProperties: { "data-asset-path": target.path, "data-asset-label": label } }, children: [{ type: "text", value: label }] }];
    }
    case "file": {
      const props = { "data-file-path": target.path, ...(target.line ? { "data-file-line": String(target.line) } : {}) };
      return [{ type: "fileLink", data: { hName: "span", hProperties: props }, children: node.children ?? [] }];
    }
    case "none":
      return node.children ?? [];
  }
}

/** Node types whose text is never scanned for bare paths. */
const OPAQUE = new Set(["code", "inlineCode", "link", "linkReference", "html", "definition", "fileLink"]);

/** Split one text node's value into text and asset-path spans. */
function splitPaths(value: string, found: (token: string) => void): MdNode[] | null {
  const parts: MdNode[] = [];
  let last = 0;
  for (const m of value.matchAll(new RegExp(OBJECT_PATH_IN_TEXT.source, "g"))) {
    const token = m[0];
    if (!classifyAssetToken(token)) continue;
    const at = m.index ?? 0;
    if (at > last) parts.push({ type: "text", value: value.slice(last, at) });
    parts.push({ type: "assetPath", data: { hName: "span", hProperties: { className: ["asset-path"], "data-asset": token } }, children: [{ type: "text", value: token }] });
    found(token);
    last = at + token.length;
  }
  if (parts.length === 0) return null;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

function walk(node: MdNode, found: (token: string) => void): void {
  if (!node.children) return;
  const next: MdNode[] = [];
  for (const child of node.children) {
    const linked = child.type === "link" ? classified(child) : null;
    if (linked) {
      next.push(...linked);
    } else if (child.type === "inlineCode") {
      const token = child.value ?? "";
      if (classifyAssetToken(token)) {
        child.data = { ...child.data, hProperties: { "data-asset": token.trim() } };
        found(token.trim());
      }
      next.push(child);
    } else if (child.type === "text" && child.value) {
      next.push(...(splitPaths(child.value, found) ?? [child]));
    } else {
      if (!OPAQUE.has(child.type)) walk(child, found);
      next.push(child);
    }
  }
  node.children = next;
}

/**
 * The remark plugin for a reply: each markdown link becomes its kind (see
 * classified), inline code that names an asset is marked (data-asset on the
 * code element) and bare object paths are wrapped in a span.asset-path.
 * Fenced code is left alone.
 */
export function remarkReplyLinks(options: { found?: (token: string) => void } = {}) {
  return (tree: MdNode) => walk(tree, options.found ?? (() => {}));
}
