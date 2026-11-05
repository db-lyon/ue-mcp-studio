/**
 * Drawing the eye to a playtest's card: a notification about a playtest
 * (see ./notify.ts) opens its session and then this.
 */

/** Open a playtest's card once the session has drawn it, scroll it into view, and mark it for a moment. */
export function focusRun(runId: string, waitMs = 5000): void {
  const end = Date.now() + waitMs;
  const look = () => {
    const el = document.querySelector(`[data-run-id="${runId.replace(/["\\]/g, "\\$&")}"]`);
    if (el) {
      el.querySelector<HTMLButtonElement>(".qa-toggle[aria-expanded='false']")?.click();
      el.scrollIntoView?.({ block: "center", behavior: "smooth" });
      el.classList.add("attention");
      setTimeout(() => el.classList.remove("attention"), 2400);
      return;
    }
    if (Date.now() < end) setTimeout(look, 100);
  };
  look();
}
