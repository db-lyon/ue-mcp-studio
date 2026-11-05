// The mobile visual QA page: ?scenario=<web visual-qa scenario>&theme=<theme>,
// the app drawn against that scenario's daemon. scripts/parity-mobile.mjs reads
// the scenario list and the parity inventory from window.__mobileQa.
import { createRoot } from "react-dom/client";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { Harness, SCENARIOS } from "./harness";
import { CardsHarness } from "./cards";
import { REFERENCE, SCENES, SceneHarness } from "./scenes";
import { PARITY } from "./parity";
import { store } from "../ui-test/mocks/secure-store";
import { setSafeAreaInsets } from "../ui-test/mocks/safe-area";
import { FILTER_KEY } from "../src/screens/playtests/Playtests";
import { AppScreenHarness, APP_SCREENS } from "./screens";

/** A phone's 3-button navigation bar over the bottom of the page: translucent, so whatever sits under it shows through. */
function drawNavigationBar(height: number) {
  const bar = document.createElement("div");
  bar.setAttribute("aria-hidden", "true");
  bar.style.cssText = `position:fixed;left:0;right:0;bottom:0;height:${height}px;z-index:2147483647;pointer-events:none;background:rgba(18,18,18,0.72);border-top:1px solid #ff2bd6;display:flex;align-items:center;justify-content:space-around;color:#cfcfcf;font:20px system-ui,sans-serif`;
  for (const glyph of ["◁", "▢", "≡"]) {
    const g = document.createElement("span");
    g.textContent = glyph;
    bar.appendChild(g);
  }
  document.body.appendChild(bar);
}

const params = new URLSearchParams(location.search);
// The web reference has no safe area to match. ?insetBottom=48 gives the app a navigation bar that tall,
// drawn over the page as a phone's 3-button bar is, to show nothing ends up under it.
const insetBottom = Math.max(0, Number(params.get("insetBottom")) || 0);
setSafeAreaInsets({ top: 0, bottom: insetBottom, left: 0, right: 0 });
if (insetBottom) drawNavigationBar(insetBottom);
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

const name = params.get("scenario") ?? "session-empty";
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;
// The Playtests page's filter, as the viewer last picked it.
const picked = SCENARIOS[name]?.filter;
if (picked) store.set(FILTER_KEY, picked);

(window as unknown as { __mobileQa: unknown }).__mobileQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, { title: s.title, height: s.height ?? 860 }])),
  parity: PARITY,
  scenes: Object.fromEntries(Object.entries(SCENES).map(([k, s]) => [k, { title: s.title, clicks: s.clicks ?? [], type: s.type ?? null, reference: REFERENCE[k] ?? null }])),
  screens: Object.keys(APP_SCREENS),
};
// ?cards=1: only the session's playtest cards, for scripts/parity-cards-mobile.mjs.
const cards = params.get("cards") === "1";
// ?screen=<name>: one of the app's own screens outside a project (pairing, projects, the fingerprint offer, a sheet), one state each.
const screen = params.get("screen");
// ?scene=<name>: one of the app's own screens in one of its states (./scenes).
const scene = params.get("scene");
createRoot(document.getElementById("root")!).render(
  scene ? <SceneHarness name={scene} theme={theme} /> : screen ? <AppScreenHarness name={screen} theme={theme} /> : cards ? <CardsHarness name={name} theme={theme} /> : <Harness name={name} theme={theme} />,
);
