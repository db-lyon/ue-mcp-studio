/**
 * Shift a tooltip or popover sideways so it stays inside the window. Docked in
 * the editor, Studio is its own narrow window over the editor's tab: anything
 * that runs past its edge is cut off, and the editor shows through where it
 * should be.
 */
export function keepInView(el: HTMLElement | null, margin = 8): void {
  if (!el) return;
  el.style.translate = "";
  const r = el.getBoundingClientRect();
  if (r.width === 0) return;
  const width = document.documentElement.clientWidth;
  let dx = 0;
  if (r.left < margin) dx = margin - r.left;
  else if (r.right > width - margin) dx = width - margin - r.right;
  if (dx) el.style.translate = `${Math.round(dx)}px 0`;
}
