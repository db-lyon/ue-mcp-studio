/**
 * The page's theme. `ue-mcp` is a fixed palette in styles.css; `editor`
 * takes its colors from the editor's active Slate theme, so the panel matches
 * whatever theme the user runs, with Unreal's default dark palette when the
 * host cannot say (a browser, or an older host plugin). `editor-orange` is
 * `editor` with the ue-mcp orange as its accent.
 */
import type { StudioTheme } from "@ue-mcp-studio/shared";
import { native } from "./native";

type EditorColors = Record<string, string>;

/** Unreal's default dark theme. */
const EDITOR_DEFAULT: EditorColors = {
  background: "#151515",
  recessed: "#1a1a1a",
  panel: "#242424",
  header: "#2f2f2f",
  input: "#0f0f0f",
  inputOutline: "#383838",
  dropdown: "#383838",
  dropdownOutline: "#4c4c4c",
  hover: "#575757",
  hover2: "#808080",
  foreground: "#c0c0c0",
  foregroundHover: "#ffffff",
  foregroundHeader: "#c8c8c8",
  primary: "#0070e0",
  primaryHover: "#0e86ff",
  select: "#0070e0",
  highlight: "#26bbff",
  warning: "#ffb800",
  error: "#ef3535",
  success: "#1fe44b",
};

let editorColors: Promise<EditorColors> | null = null;

function loadEditorColors(): Promise<EditorColors> {
  editorColors ??= (async () => {
    try {
      const raw = await native().geteditortheme?.();
      return raw ? { ...EDITOR_DEFAULT, ...(JSON.parse(raw) as EditorColors) } : EDITOR_DEFAULT;
    } catch {
      return EDITOR_DEFAULT;
    }
  })();
  return editorColors;
}

/** The top bar's color for a theme, which a mobile browser paints its own toolbar with. */
export function themeColor(theme: StudioTheme, colors: EditorColors = EDITOR_DEFAULT): string {
  return theme === "editor" || theme === "editor-orange" ? colors.recessed ?? EDITOR_DEFAULT.recessed : "#0c0c0b";
}

function setThemeColor(color: string): void {
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

export async function applyTheme(theme: StudioTheme): Promise<void> {
  const root = document.documentElement;
  root.dataset.theme = theme;
  for (const name of Object.keys(EDITOR_DEFAULT)) root.style.removeProperty(`--ue-${name}`);
  if (theme !== "editor" && theme !== "editor-orange") return setThemeColor(themeColor(theme));
  const colors = await loadEditorColors();
  if (root.dataset.theme !== theme) return;
  for (const [name, value] of Object.entries(colors)) root.style.setProperty(`--ue-${name}`, value);
  setThemeColor(themeColor(theme, colors));
}
