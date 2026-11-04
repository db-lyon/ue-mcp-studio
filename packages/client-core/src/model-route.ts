/**
 * How a model runs, in words the model picker, the Models table and the
 * sign-in rows share: the route it would take now, and that route's name.
 */
import { routesInOrder, type ModelCatalog, type ModelOption, type SignInId, type VendorId } from "@ue-mcp-studio/shared";

type Vendor = ModelCatalog["providers"][number];
export type Via = SignInId | "key" | "endpoint";

/**
 * How a model would run now: a custom endpoint's on that endpoint; a named
 * vendor's on the first connected sign-in or key by the route order; else nothing.
 */
export function runsVia(catalog: ModelCatalog, vendor: Vendor, m: ModelOption): Via | null {
  if (vendor.endpoint) return "endpoint";
  return routesInOrder(m.signIns, catalog.routeOrder).find((r) => (r === "key" ? vendor.connected : catalog.signedIn[r])) ?? null;
}

/** One name per route, the same in the picker, the Models table and the sign-in rows. */
export const VIA_LABEL: Record<SignInId | "key", string> = { chatgpt: "ChatGPT sign-in", claude: "Claude sign-in", studio: "Studio plan", key: "key" };

/** A route's name beside a model: a key and an endpoint by their vendor's name. */
export function viaName(via: Via, vendorName: string): string {
  return via === "endpoint" ? vendorName : via === "key" ? `${vendorName} key` : VIA_LABEL[via];
}

/** A model in the catalog by its vendor and id. */
export function findModel(catalog: ModelCatalog | null, vendor: VendorId, model: string): { vendor: Vendor; model: ModelOption } | null {
  const v = catalog?.providers.find((p) => p.id === vendor);
  const m = v?.models.find((x) => x.id === model);
  return v && m ? { vendor: v, model: m } : null;
}

/** What a model nothing connected can run says beside it on a paired device, where sign-ins and keys cannot be added. */
export const CONNECT_ON_COMPUTER = "Connect on your computer";

/**
 * The word beside a model nothing connected runs: "sign in" or "connect" on
 * the computer; on a paired device, which cannot add either, CONNECT_ON_COMPUTER.
 */
export function lockedVia(m: Pick<ModelOption, "signIns">, remote: boolean): string {
  if (remote) return CONNECT_ON_COMPUTER;
  return m.signIns.length ? "sign in" : "connect";
}
