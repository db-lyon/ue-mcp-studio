// The visual QA page: one scene, named by ?scene=, with the relay's account
// answered from fixtures so Projects and Devices render as they would paired.
import { createRoot } from "react-dom/client";
import { store } from "../ui-test/mocks/secure-store";
import { Scene, SCENES } from "./scenes";

store.set("trusted", JSON.stringify({ keyA: { pairedAt: "2026-10-30T09:00:00Z" } }));
const account = {
  devices: [
    { id: "dev1", name: "Lyra", online: true, computerKey: "keyA", lastSeen: "2026-11-04T12:00:00Z" },
    { id: "dev2", name: "ShooterGame", online: false, computerKey: "keyA", lastSeen: "2026-11-02T18:40:00Z" },
    { id: "dev3", name: "Studio laptop: CitySample", online: true, computerKey: "keyB", lastSeen: "2026-11-04T12:00:00Z" },
  ],
  viewers: [
    { id: "v1", label: "Android (Studio app)", createdAt: "2026-11-04T08:00:00Z", current: true },
    { id: "v2", label: "Windows (Edge)", createdAt: "2026-10-21T08:00:00Z", current: false },
    { id: "v3", label: "iPhone (Safari)", createdAt: "2026-10-12T08:00:00Z", current: false },
  ],
};
window.fetch = (async (url: string) => {
  if (String(url).endsWith("/api/devices")) return new Response(JSON.stringify(account), { status: 200, headers: { "content-type": "application/json" } });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

(window as unknown as { __scenes: unknown }).__scenes = Object.fromEntries(Object.entries(SCENES).map(([k, v]) => [k, { click: v.click ?? null }]));
const name = new URLSearchParams(location.search).get("scene") ?? "welcome";
createRoot(document.getElementById("root")!).render(<Scene name={name} />);
