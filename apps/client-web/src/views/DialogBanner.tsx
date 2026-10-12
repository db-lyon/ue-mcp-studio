/** A dialog holding the editor, above every view, so a stalled turn is never silent. */
import { DialogBannerLine } from "../chat/Dialogs";
import { useDialogs } from "../chat/dialog-model";
import type { DaemonState } from "../state";

export function DialogBanner({ daemon }: { daemon: DaemonState }) {
  const { state, now } = useDialogs(daemon);
  const first = state?.dialogs[0];
  return first ? <DialogBannerLine dialog={first} now={now()} /> : null;
}
