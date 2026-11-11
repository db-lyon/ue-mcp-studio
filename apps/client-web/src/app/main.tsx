import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "../styles.css";
import "./app.css";
import { App } from "./App";
import { followScheme } from "./scheme";

followScheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
