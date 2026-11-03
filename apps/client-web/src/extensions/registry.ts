import { useSyncExternalStore } from "react";
import { SLOT_NAMES, type SlotContribution, type SlotName } from "@ue-mcp-studio/extension-api";

/** A contribution in a slot, with the extension that registered it. key is `${ext}:${id}`. */
export interface SlotItem<S extends SlotName = SlotName> {
  key: string;
  ext: string;
  slot: S;
  contribution: SlotContribution<S>;
}

/** Extension names and contribution ids: safe in a hash, a DOM attribute and a route. */
export const NAME = /^[A-Za-z0-9_-]{1,64}$/;

const EMPTY: readonly SlotItem[] = Object.freeze([]);
let items: Array<SlotItem & { seq: number }> = [];
const views = new Map<SlotName, readonly SlotItem[]>();
const listeners = new Set<() => void>();
let seq = 0;

function changed(): void {
  views.clear();
  for (const l of listeners) l();
}

/**
 * Adds a contribution to a slot for an extension; the function returned takes it
 * out. The same extension, slot and id again replaces the earlier one.
 */
export function register<S extends SlotName>(slot: S, contribution: SlotContribution<S>, ext: string): () => void {
  if (!(SLOT_NAMES as readonly string[]).includes(slot)) throw new Error(`unknown slot "${slot}"`);
  if (!NAME.test(ext)) throw new Error(`invalid extension name "${ext}"`);
  if (!contribution || !NAME.test(contribution.id)) throw new Error(`invalid contribution id "${contribution?.id}"`);
  if (typeof contribution.mount !== "function") throw new Error(`contribution "${contribution.id}" has no mount`);
  const item = { key: `${ext}:${contribution.id}`, ext, slot, contribution, seq: seq++ } as SlotItem & { seq: number };
  items = [...items.filter((i) => !(i.slot === slot && i.key === item.key)), item];
  changed();
  return () => {
    if (!items.includes(item)) return;
    items = items.filter((i) => i !== item);
    changed();
  };
}

/** A slot's contributions: lower order first, ties in registration order. */
export function slotItems<S extends SlotName>(slot: S): readonly SlotItem<S>[] {
  let view = views.get(slot);
  if (!view) {
    const found = items.filter((i) => i.slot === slot).sort((a, b) => (a.contribution.order ?? 0) - (b.contribution.order ?? 0) || a.seq - b.seq);
    view = found.length ? found : EMPTY;
    views.set(slot, view);
  }
  return view as readonly SlotItem<S>[];
}

export function useSlot<S extends SlotName>(slot: S): readonly SlotItem<S>[] {
  return useSyncExternalStore(subscribe, () => slotItems(slot));
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** Removes every contribution. For tests. */
export function clearSlots(): void {
  items = [];
  changed();
}
