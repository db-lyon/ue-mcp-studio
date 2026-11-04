// The mobile visual QA page: ?scenario=<web visual-qa scenario>&theme=<theme>,
// the app drawn against that scenario's daemon. scripts/parity-mobile.mjs reads
// the scenario list and the parity inventory from window.__mobileQa.
import { createRoot } from "react-dom/client";
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { Harness, SCENARIOS } from "./harness";
import { PARITY } from "./parity";

const params = new URLSearchParams(location.search);
const name = params.get("scenario") ?? "session-empty";
const theme = (params.get("theme") ?? "ue-mcp") as StudioTheme;

(window as unknown as { __mobileQa: unknown }).__mobileQa = {
  scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, { title: s.title, height: s.height ?? 860 }])),
  parity: PARITY,
};
createRoot(document.getElementById("root")!).render(<Harness name={name} theme={theme} />);
