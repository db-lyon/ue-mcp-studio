/**
 * The app adds a native way in and never takes over the browser's: no intent
 * filter or associated domain claims the relay's https links, so a pairing
 * code scanned with the system camera or opened in a browser stays there.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const app = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app.json"), "utf8")).expo;

describe("app.json", () => {
  it("claims no https link on the relay's host", () => {
    const filters: Array<{ data?: Array<{ scheme?: string; host?: string }> | { scheme?: string; host?: string } }> = app.android?.intentFilters ?? [];
    const data = filters.flatMap((f) => (Array.isArray(f.data) ? f.data : f.data ? [f.data] : []));
    expect(data.filter((d) => d.scheme === "https" || d.scheme === "http" || /ue-mcp\.com/.test(d.host ?? ""))).toEqual([]);
    expect((app.ios?.associatedDomains ?? []).filter((d: string) => /ue-mcp\.com/.test(d))).toEqual([]);
  });

  it("keeps its own scheme for an explicit Open in app", () => {
    expect(app.scheme).toBe("uemcpstudio");
  });

  // Build 8: with predictive back on, Android 13+ sent back to OnBackInvokedCallback, never to
  // React Native's BackHandler, and the system closed the app from every screen.
  it("leaves predictive back off, so system back reaches BackHandler", () => {
    expect(app.android?.predictiveBackGestureEnabled).toBe(false);
  });
});

describe("the generated Android manifest", () => {
  const manifest = path.join(__dirname, "..", "android", "app", "src", "main", "AndroidManifest.xml");
  it.skipIf(!fs.existsSync(manifest))("has no intent filter for the relay's host", () => {
    const xml = fs.readFileSync(manifest, "utf8");
    expect(xml).not.toMatch(/android:host="[^"]*ue-mcp\.com"/);
    expect(xml).not.toMatch(/android:autoVerify="true"/);
  });
  it.skipIf(!fs.existsSync(manifest))("does not opt into OnBackInvokedCallback", () => {
    expect(fs.readFileSync(manifest, "utf8")).not.toMatch(/android:enableOnBackInvokedCallback="true"/);
  });
});
