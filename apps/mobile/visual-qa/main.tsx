// The mobile visual QA page: ?scenario=<web visual-qa scenario>&theme=<theme>,
// the app drawn against that scenario's daemon. scripts/parity-mobile.mjs reads
// the scenario list and the parity inventory from window.__mobileQa.
import { createRoot } from "react-dom/client";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { Harness, SCENARIOS } from "./harness";
import { PARITY } from "./parity";

// The web reference has no safe area to match.
(globalThis as { __qaInsets?: unknown }).__qaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
// Animations are shot at full strength, as the web harness freezes them (ui/Pulse reads this).
(globalThis as { __studioFreezeAnimations?: boolean }).__studioFreezeAnimations = true;

// react-native-web gives every ScrollView translateZ(0) for scrolling speed. That puts the
// list on its own GPU layer, where Chrome draws text greyscale instead of with the
// subpixel antialiasing the web client's plain scrollers keep, so every line of the
// transcript would differ from the reference by its antialiasing alone. A phone draws
// neither, so the harness drops the hint.
function dropScrollLayers() {
  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const r of rules) if (r instanceof CSSStyleRule && /^translateZ\(0(px)?\)$/.test(r.style.transform)) r.style.transform = "none";
  }
}
dropScrollLayers();
requestAnimationFrame(dropScrollLayers);

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "session-empty";
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;

(window as unknown as { __mobileQa: unknown }).__mobileQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, { title: s.title, height: s.height ?? 860 }])),
  parity: PARITY,
};
createRoot(document.getElementById("root")!).render(<Harness name={name} theme={theme} />);
