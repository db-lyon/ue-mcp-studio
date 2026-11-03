/**
 * The contract between UE-MCP Studio and its extensions: API versions, UI slots
 * and their contexts, and the card an extension posts. Types and constants only.
 */

/** The agent-side API Studio offers other daemon extensions. Bumped on a breaking change. */
export const STUDIO_AGENT_API_VERSION = 1;
/** The UI API: slots, contribution and context shapes. Bumped on a breaking change. */
export const STUDIO_UI_API_VERSION = 1;

/** Every named place in the Studio UI an extension can fill. */
export const SLOT_NAMES = ["settings.section", "chat.card", "toolbar.action", "composer.action", "session.panel"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** A session's turn state, as Studio reports it. */
export type SessionStatus = "idle" | "running" | "waiting" | "stopped" | "error";

/** One event from the daemon's event feed. */
export interface StudioEvent {
  id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** Requests to the extension's own daemon routes. Paths are relative to /v1/ext/<extension>/. */
export interface ExtensionFetch {
  fetchJson<T = unknown>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
}

/** The daemon's event feed, the one Studio already reads. */
export interface ExtensionEvents {
  subscribe(listener: (e: StudioEvent) => void): () => void;
}

/** What every slot's context carries. */
export interface BaseContext {
  api: ExtensionFetch;
  events: ExtensionEvents;
}

/** What each slot hands its contributions. */
export interface SlotContexts {
  /** A section of its own in Settings, listed in the rail. */
  "settings.section": BaseContext;
  /** A card posted into a conversation; the contribution's id is the card type it draws. */
  "chat.card": BaseContext & { sessionId: string; data: unknown };
  /** A control in the header bar. */
  "toolbar.action": BaseContext;
  /** A control in the composer's bar, after Attach. */
  "composer.action": BaseContext & {
    sessionId: string;
    draft: string;
    setDraft(text: string): void;
    busy: boolean;
    addFiles(files: FileList | File[]): void;
  };
  /** A collapsible region under the open session's conversation. */
  "session.panel": BaseContext & { sessionId: string; status: SessionStatus };
}

export type SlotContext<S extends SlotName> = SlotContexts[S];

/** A mounted contribution. update gets each new context; unmount runs when it is removed. */
export interface SlotInstance<S extends SlotName = SlotName> {
  update?(ctx: SlotContext<S>): void;
  unmount(): void;
}

/**
 * What an extension puts in a slot, framework-neutral: Studio hands it an
 * element and a context. Lower order comes first; ties keep registration order.
 */
export interface SlotContribution<S extends SlotName = SlotName> {
  id: string;
  title?: string;
  order?: number;
  mount(el: HTMLElement, ctx: SlotContext<S>): SlotInstance<S>;
}

/** Adds a contribution to a slot; the function returned takes it out again. */
export type RegisterSlot = <S extends SlotName>(slot: S, contribution: SlotContribution<S>) => () => void;

/** What Studio passes a UI module's activate. */
export interface ActivateContext {
  register: RegisterSlot;
  apiVersion: number;
}

/** A UI module's exports: the UI API versions it works with, and activate. */
export interface StudioUiModule {
  studioUi: { min: number; max: number };
  activate(ctx: ActivateContext): void | (() => void);
}

/** A card an extension posts into a session; Studio adds the extension's name. */
export interface CardPost {
  type: string;
  data: unknown;
}

/** The card as it is kept in the transcript, drawn by the chat.card contribution registered for `${ext}:${type}`. */
export interface CardEntry extends CardPost {
  kind: "card";
  ext: string;
  at: string;
}
