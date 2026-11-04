// The mobile visual QA page: ?scenario=<web visual-qa scenario>&theme=<theme>,
// the app drawn against that scenario's daemon. scripts/parity-mobile.mjs reads
// the scenario list and the parity inventory from window.__mobileQa.
import { createRoot } from "react-dom/client";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { Harness, SCENARIOS } from "./harness";
import { CardsHarness } from "./cards";
import { PARITY } from "./parity";
import { store } from "../ui-test/mocks/secure-store";
import { FILTER_KEY } from "../src/screens/playtests/Playtests";

// The web reference has no safe area to match.
(globalThis as { __qaInsets?: unknown }).__qaInsets = { top: 0, bottom: 0, left: 0, right: 0 };
// Animations are shot at full strength, as the web harness freezes them (ui/Pulse reads this).
(globalThis as { __studioFreezeAnimations?: boolean }).__studioFreezeAnimations = true;

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "session-empty";
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;
// The Playtests page's filter, as the viewer last picked it.
const picked = SCENARIOS[name]?.filter;
if (picked) store.set(FILTER_KEY, picked);

(window as unknown as { __mobileQa: unknown }).__mobileQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, { title: s.title, height: s.height ?? 860 }])),
  parity: PARITY,
};
// ?cards=1: only the session's playtest cards, for scripts/parity-cards-mobile.mjs.
const cards = params.get("cards") === "1";
createRoot(document.getElementById("root")!).render(cards ? <CardsHarness name={name} theme={theme} /> : <Harness name={name} theme={theme} />);
