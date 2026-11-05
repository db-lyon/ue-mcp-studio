/**
 * The project's ue-mcp plugins as a client lists them: the installed ones and
 * the registry's catalog, searched and matched. Installing, updating and
 * removing run only on the computer; a paired client shows the lists read only.
 */

/** A plugin in the project, from GET /v1/plugins. */
export interface InstalledPlugin {
  name: string;
  version: string | null;
  pinned: string | null;
  status: "ok" | "missing" | "invalid";
  categories: string[];
  problems: string[];
}

/** A plugin the registry publishes, from GET /v1/plugins/catalog. */
export interface CatalogPlugin {
  slug: string;
  name: string;
  packageName?: string;
  tagline?: string;
  description?: string;
  readme?: string;
  category?: string;
  tags?: string[];
  repoUrl?: string;
  homepageUrl?: string;
}

/** What an install, update or uninstall did. */
export interface PluginCommandResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
  restartRequired: boolean;
}

/**
 * What a catalog card's Details shows: the readme, else the description,
 * else "No description.". The registry sends an empty readme for a plugin
 * without one, so a blank field counts as missing.
 */
export function catalogDetails(c: Pick<CatalogPlugin, "readme" | "description">): string {
  for (const text of [c.readme, c.description]) if (text && text.trim()) return text;
  return "No description.";
}

/** A catalog entry and an installed plugin are the same plugin when either name matches. */
export function isInstalled(c: CatalogPlugin, installed: InstalledPlugin[]): InstalledPlugin | undefined {
  return installed.find((p) => p.name === c.slug || p.name === c.packageName);
}

/** Catalog entries matching a search over name, slug, tagline, category and tags. */
export function searchCatalog(catalog: CatalogPlugin[], query: string): CatalogPlugin[] {
  const q = query.trim().toLowerCase();
  if (!q) return catalog;
  return catalog.filter((c) => [c.name, c.slug, c.tagline, c.category, ...(c.tags ?? [])].some((s) => s?.toLowerCase().includes(q)));
}

/** What a paired client says in place of install, update and remove, which only run on the computer. */
export const REMOTE_PLUGINS_NOTE = "Installing, updating and removing plugins run from Studio on the computer.";
