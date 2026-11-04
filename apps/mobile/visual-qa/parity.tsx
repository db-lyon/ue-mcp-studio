// The parity page: one scene, named by ?scene=, drawn by the app's own screens
// against the web client's visual QA fixtures, for scripts/visual-parity-mobile.mjs.
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import { createRoot } from "react-dom/client";
import { SCENES } from "./parity/scenes";

const name = new URLSearchParams(location.search).get("scene") ?? "";
const scene = SCENES[name];
(window as unknown as { __parity: string[] }).__parity = Object.keys(SCENES);
createRoot(document.getElementById("root")!).render((scene ? scene() : <div style={{ color: "#fff" }}>No scene {name}</div>) as never);
