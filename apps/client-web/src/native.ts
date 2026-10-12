/**
 * The editor's native bindings, when the page runs inside the Studio dock tab.
 *
 * The client plugin binds a UObject as `window.ue.studio`; Unreal lowercases
 * its function names and every call returns a Promise. In a plain browser
 * (the fallback while the editor is down, or `npm run dev`) the same calls
 * resolve to a logged no-op, so views never branch on where they run.
 */
interface StudioBinding {
  restarteditor(): Promise<boolean>;
  enableplugin(name: string): Promise<boolean>;
  openprojectfolder(): Promise<boolean>;
  /** JSON of the editor's active theme colors; older host plugins do not have it. */
  geteditortheme?(): Promise<string>;
  /** `ue-mcp init --dry-run` in the background, its JSON plan, and init with the page's choices. */
  startsetupplan?(): Promise<boolean>;
  getsetupplan?(): Promise<string>;
  runsetup?(options: string): Promise<boolean>;
  /** Flash the editor in the taskbar and show a toast; older host plugins do not have it. */
  drawattention?(message: string): Promise<boolean>;
  /** Open the ue-mcp docs in their own editor tab; older host plugins do not have it. */
  opendocs?(path: string): Promise<boolean>;
  /** Start the project's daemon (or install Studio first when it is missing). */
  startdaemon?(): Promise<boolean>;
  /** Studio's own window only: JSON of { mode: "docked" | "window", canDock }. canDock is false with a plugin that has no dock tab. */
  getwindowmode?(): Promise<string>;
  /** Studio's own window only: dock it in the editor's tab, or open it as a window, and keep that for the project. */
  setwindowmode?(mode: "docked" | "window"): Promise<boolean>;
}

declare global {
  interface Window {
    ue?: { studio?: StudioBinding };
  }
}

const stub: StudioBinding = {
  restarteditor: async () => {
    console.info("[studio] restartEditor is only available inside the editor");
    return false;
  },
  enableplugin: async (name) => {
    console.info(`[studio] enablePlugin(${name}) is only available inside the editor`);
    return false;
  },
  openprojectfolder: async () => {
    console.info("[studio] openProjectFolder is only available inside the editor");
    return false;
  },
};

export const inEditor = (): boolean => !!window.ue?.studio;
export const native = (): StudioBinding => window.ue?.studio ?? stub;

/** The ue-mcp docs: in their own editor tab when the host plugin can, else a browser tab. */
export async function openDocs(path = "/docs/"): Promise<void> {
  const opened = await native().opendocs?.(path).catch(() => false);
  if (!opened) window.open(`https://ue-mcp.com${path}`, "_blank", "noopener");
}
