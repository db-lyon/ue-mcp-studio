/**
 * Pointer drags drawn without React: a drag writes positions straight onto
 * the elements it moves, at most once a frame, and hands its result to React
 * once, on release. Nothing re-renders while the pointer moves, so a drag
 * stays smooth however large the view around it is.
 */

/** Where the pointer is during a drag, relative to where it went down. */
export interface DragPoint {
  dx: number;
  dy: number;
  clientX: number;
  clientY: number;
  alt: boolean;
  shift: boolean;
}

export interface DragHandlers {
  /** Called at most once a frame with the newest position. */
  move: (p: DragPoint) => void;
  /** Called once on release with the release position, after any frame still due was dropped. */
  up: (p: DragPoint) => void;
  /** Called instead of up when the drag is cancelled (Escape, a lost pointer). */
  cancel?: () => void;
}

const frame = (fn: () => void): (() => void) => {
  if (typeof window.requestAnimationFrame === "function") {
    const id = window.requestAnimationFrame(fn);
    return () => window.cancelAnimationFrame(id);
  }
  const id = setTimeout(fn, 16);
  return () => clearTimeout(id);
};

/**
 * Follow a pointer from this pointerdown until it is released. Moves are
 * folded into one call per animation frame; the release is reported at once,
 * with its own position, so a quick drag lands where it was let go.
 */
export function followPointer(e: { clientX: number; clientY: number; pointerId?: number }, h: DragHandlers): () => void {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let latest: DragPoint | null = null;
  let due: (() => void) | null = null;
  const point = (m: MouseEvent): DragPoint => ({ dx: m.clientX - x0, dy: m.clientY - y0, clientX: m.clientX, clientY: m.clientY, alt: m.altKey, shift: m.shiftKey });
  const mine = (m: Event) => {
    const id = (m as PointerEvent).pointerId;
    return e.pointerId === undefined || id === undefined || id === e.pointerId;
  };
  const move = (m: Event) => {
    if (!mine(m)) return;
    latest = point(m as MouseEvent);
    if (due) return;
    // A host that runs the frame at once (a test) has run it before frame() returns.
    let ran = false;
    const cancelFrame = frame(() => {
      ran = true;
      due = null;
      if (latest) h.move(latest);
    });
    if (!ran) due = cancelFrame;
  };
  const stop = () => {
    due?.();
    due = null;
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", up, true);
    window.removeEventListener("pointercancel", cancel, true);
    window.removeEventListener("keydown", key, true);
  };
  const up = (m: Event) => {
    if (!mine(m)) return;
    stop();
    h.up(point(m as MouseEvent));
  };
  const cancel = () => {
    stop();
    h.cancel?.();
  };
  const key = (k: KeyboardEvent) => {
    if (k.key !== "Escape") return;
    k.preventDefault();
    k.stopPropagation();
    cancel();
  };
  // Capture phase on the window: the drag hears the pointer wherever it goes, before anything under it.
  window.addEventListener("pointermove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("pointercancel", cancel, true);
  window.addEventListener("keydown", key, true);
  return cancel;
}

/**
 * Note the style React gave an element before a drag writes over it; the
 * function returned puts it back, so the render that follows the drop draws
 * from React's own values. Clearing the style instead would leave an element
 * with no position when the drop changes nothing React draws.
 */
export function hold(el: HTMLElement | null | undefined): () => void {
  if (!el) return () => {};
  const s = { transform: el.style.transform, width: el.style.width, left: el.style.left, zIndex: el.style.zIndex, display: el.style.display };
  return () => {
    Object.assign(el.style, s);
    delete el.dataset.dragging;
  };
}

/** Capture the pointer on an element, where the page supports it. */
export function capture(el: Element, pointerId: number | undefined): void {
  if (pointerId === undefined) return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // jsdom and some pens have no capture; the drag still follows the window.
  }
}

/**
 * Slide an element from where it was drawn before (`from`) to where it is
 * drawn now: how a refused edit puts a block back. Without the Web
 * Animations API it simply stays where it now is.
 */
export function slideFrom(el: Element | null | undefined, from: DOMRect | null | undefined, ms = 180): void {
  if (!el || !from || typeof (el as HTMLElement).animate !== "function") return;
  const to = el.getBoundingClientRect();
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (!dx && !dy && from.width === to.width) return;
  const sx = to.width > 0 ? from.width / to.width : 1;
  (el as HTMLElement).animate(
    [{ transform: `translate(${dx}px, ${dy}px) scaleX(${sx})`, transformOrigin: "left center" }, { transform: "none", transformOrigin: "left center" }],
    { duration: ms, easing: "cubic-bezier(.2,.7,.3,1)" },
  );
}

/** The element a refusal slides back, found by its data key inside a root. */
export const keyed = (root: ParentNode | null | undefined, attr: string, key: string): HTMLElement | null =>
  root ? root.querySelector<HTMLElement>(`[${attr}="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key.replace(/"/g, '\\"')}"]`) : null;
