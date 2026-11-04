import type { ReactNode } from "react";
import { onRemotePage } from "../../connection";

/** Why a paired browser cannot change a setting: it decides where prompts go or what runs on the computer. */
export const REMOTE_CHANGE_NOTE = "Change this from Studio on the computer.";

/**
 * In a paired browser, shows its children read only (a disabled fieldset) under
 * the note above. The computer refuses these writes from a paired browser
 * anyway (remotePath, remoteBodyAllowed); this keeps the page from offering them.
 */
export function RemoteReadOnly({ children, remote = onRemotePage() }: { children: ReactNode; remote?: boolean }) {
  if (!remote) return <>{children}</>;
  return (
    <fieldset className="remote-readonly" disabled>
      <p className="dim small remote-readonly-note">{REMOTE_CHANGE_NOTE}</p>
      {children}
    </fieldset>
  );
}
