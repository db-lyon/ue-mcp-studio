/**
 * useStudioFonts in a build with the fonts built in (the expo-font config
 * plugin): ready on the first render, nothing loaded again. Without them, it
 * loads only what is missing, and a failed load lets the app go on with the
 * system font and says so instead of passing as loaded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const native = vi.hoisted(() => ({ loaded: [] as string[], useFonts: vi.fn((_map: Record<string, unknown>): [boolean, Error | null] => [false, null]) }));
vi.mock("expo-font", () => ({ getLoadedFonts: () => native.loaded, useFonts: native.useFonts, isLoaded: () => false, loadAsync: async () => undefined }));

import { FONT_FILES, fontsToLoad, useStudioFonts } from "../src/ui";

function Probe({ seen }: { seen: boolean[] }) {
  seen.push(useStudioFonts());
  return null;
}

describe("useStudioFonts", () => {
  beforeEach(() => {
    native.loaded = [];
    native.useFonts.mockReset();
    native.useFonts.mockImplementation(() => [false, null]);
  });

  it("is ready on the first render when every font is built in, and loads none of them again", () => {
    native.loaded = [...FONT_FILES, "SomeOtherFont"];
    const seen: boolean[] = [];
    render(<Probe seen={seen} />);
    expect(seen[0]).toBe(true);
    expect(native.useFonts).toHaveBeenCalledWith({});
  });

  it("loads only the fonts the build lacks", () => {
    native.loaded = FONT_FILES.filter((n) => n !== "Roboto_700Bold");
    const seen: boolean[] = [];
    render(<Probe seen={seen} />);
    expect(seen[0]).toBe(false);
    expect(Object.keys(native.useFonts.mock.calls[0][0])).toEqual(["Roboto_700Bold"]);
    expect(Object.keys(fontsToLoad(new Set(native.loaded)))).toEqual(["Roboto_700Bold"]);
  });

  it("goes on with the system font when a load fails, and says so", () => {
    native.useFonts.mockImplementation(() => [false, new Error("no such asset")]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: boolean[] = [];
    render(<Probe seen={seen} />);
    expect(seen.at(-1)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no such asset"));
    warn.mockRestore();
  });

  it("does not block when the native module cannot list its fonts", () => {
    native.loaded = undefined as never;
    expect(Object.keys(fontsToLoad(new Set()))).toHaveLength(12);
  });
});
