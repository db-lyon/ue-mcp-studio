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
