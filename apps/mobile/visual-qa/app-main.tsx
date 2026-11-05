// The app's real entry (App.tsx, what the APK launches) in the browser, for scripts/e2e-mobile-live.mjs.
//   app.html                      against the live relay, through the script's /relay proxy
//   app.html?fake=<scenario>      against a fake relay in the page, whose computer answers from that
//                                 web visual-qa scenario, already paired (see ./fake-relay.ts)
//   ...&offlineMs=<ms>            with the computer away for that long first
//   ...&huge=1                    with a long session (about 8 MB of transcript) listed first
import { createRoot } from "react-dom/client";
import App from "../App";
import { installFakeRelay } from "./fake-relay";

// The browser has no safe area.
(globalThis as { __qaInsets?: unknown }).__qaInsets = { top: 0, bottom: 0, left: 0, right: 0 };

const query = new URLSearchParams(location.search);
const fake = query.get("fake");
void (fake ? installFakeRelay(fake, Number(query.get("offlineMs") ?? 0), query.get("huge") === "1") : Promise.resolve()).then(() => {
  (window as unknown as { __e2eReady: boolean }).__e2eReady = true;
  createRoot(document.getElementById("root")!).render(<App />);
});
