import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { onRemotePage } from "./connection";
import { installLockGuard, refreshLock } from "./remote-lock";
import { CLIPS_WINDOW_HASH } from "./views/hub/arrangement-sync";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-700.css";
import "./styles.css";
import "./settings.css";

// Before the first render: the views fetch as they mount, and a request the
// computer locks must wait for the PIN and go again, not fail.
if (onRemotePage()) {
  installLockGuard();
  void refreshLock();
}

// The Arrangement's Clips window is a page of its own: Clips alone, kept in step with the Arrangement that opened it.
const root = createRoot(document.getElementById("root")!);
if (location.hash === CLIPS_WINDOW_HASH) {
  void import("./views/hub/ClipsWindow").then(({ ClipsWindow }) => root.render(<StrictMode><ClipsWindow /></StrictMode>));
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
