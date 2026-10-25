import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-700.css";
import "./styles.css";
import "./settings.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
