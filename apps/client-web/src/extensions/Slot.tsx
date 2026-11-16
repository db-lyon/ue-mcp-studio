import { Component, Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SlotContext, SlotInstance, SlotName } from "@ue-mcp-studio/extension-api";
import { useSlot, type SlotItem } from "./registry";
import { baseContext } from "./context";

/** A slot's own context; api and events are added per extension. */
export type SlotCtx<S extends SlotName> = Omit<SlotContext<S>, "api" | "events">;

/**
 * Every contribution to a slot, each mounted into an element of its own and
 * contained on its own. With nothing registered it renders nothing at all.
 */
export function Slot<S extends SlotName>({ name, ctx, wrap }: {
  name: S;
  ctx: SlotCtx<S>;
  /** Puts each contribution's element in a frame of its own, such as a panel. */
  wrap?: (item: SlotItem<S>, host: ReactNode) => ReactNode;
}) {
  const list = useSlot(name);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((item) => {
        const host = <Contribution item={item} ctx={ctx} />;
        return <Fragment key={item.key}>{wrap ? wrap(item, host) : host}</Fragment>;
      })}
    </>
  );
}

/**
 * One contribution: a failure in it is logged and leaves a small note with
 * Reload in its place, and the rest of the panel carries on.
 */
export function Contribution<S extends SlotName>({ item, ctx }: { item: SlotItem<S>; ctx: SlotCtx<S> }) {
  return (
    <Contained label={`${item.slot} ${item.key}`} failed={(reload) => <FailedNote item={item} onReload={reload} />}>
      <Host item={item} ctx={ctx} />
    </Contained>
  );
}

/** A contribution that failed, named by its extension, with Reload to mount it again. */
function FailedNote({ item, onReload }: { item: SlotItem; onReload: () => void }) {
  return (
    <span className="ext-failed small" role="status" data-slot={item.slot} data-ext={item.ext}>
      <span className="dim">{extensionFailed(item.ext)}</span>
      <button type="button" className="ghost small-button" aria-label={`Reload extension ${item.ext}`} onClick={onReload}>Reload</button>
    </span>
  );
}

/** What a failed contribution says in its place. */
export const extensionFailed = (ext: string): string => `Extension ${ext} failed.`;

function Host<S extends SlotName>({ item, ctx }: { item: SlotItem<S>; ctx: SlotCtx<S> }) {
  const el = useRef<HTMLDivElement>(null);
  const instance = useRef<SlotInstance<S> | null>(null);
  const sent = useRef<SlotContext<S> | null>(null);
  const [failed, setFailed] = useState(false);
  const full = useStable({ ...ctx, ...baseContext(item.ext) } as SlotContext<S>);
  const fail = (what: string, e: unknown) => {
    console.error(`Extension ${item.key} failed to ${what} in ${item.slot}`, e);
    setFailed(true);
  };

  useLayoutEffect(() => {
    if (failed || !el.current) return;
    try {
      instance.current = item.contribution.mount(el.current, full);
      sent.current = full;
    } catch (e) {
      fail("mount", e);
      return;
    }
    return () => {
      const mounted = instance.current;
      instance.current = null;
      sent.current = null;
      try {
        mounted?.unmount();
      } catch (e) {
        console.error(`Extension ${item.key} failed to unmount from ${item.slot}`, e);
      }
    };
    // Mounted once per contribution; context changes go through update below.
  }, [item, failed]);

  useLayoutEffect(() => {
    if (!instance.current || sent.current === full) return;
    sent.current = full;
    try {
      instance.current.update?.(full);
    } catch (e) {
      fail("update", e);
    }
  }, [full]);

  if (failed) return <FailedNote item={item} onReload={() => setFailed(false)} />;
  return <div ref={el} className="ext-slot" data-slot={item.slot} data-ext={item.ext} data-contribution={item.contribution.id} />;
}

/** The same object while every field is the same, so a re-render with equal context sends no update. */
function useStable<T extends object>(value: T): T {
  const last = useRef(value);
  const a = last.current as Record<string, unknown>;
  const b = value as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length || keys.some((k) => a[k] !== b[k])) last.current = value;
  return last.current;
}

/** Catches a render-time throw below it; `failed` draws what shows instead, with a reload that mounts it again. */
class Contained extends Component<{ label: string; failed: (reload: () => void) => ReactNode; children: ReactNode }, { failed: boolean; mount: number }> {
  state = { failed: false, mount: 0 };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`Extension ${this.props.label} could not be shown`, error);
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.failed(() => this.setState((s) => ({ failed: false, mount: s.mount + 1 })));
    return <Fragment key={this.state.mount}>{this.props.children}</Fragment>;
  }
}
