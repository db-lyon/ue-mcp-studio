/**
 * A dialog holding the editor, above every view, so a stalled turn is never
 * silent. A native Windows dialog (a GPU device loss, an assert box) is drawn
 * as its whole card here, with its buttons: it may belong to no session, and
 * it holds the editor whatever the user is looking at.
 */
import { DialogBannerLine, DialogCard } from "../chat/Dialogs";
import { useDialogs } from "../chat/dialog-model";
import type { DaemonState } from "../state";

export function DialogBanner({ daemon }: { daemon: DaemonState }) {
  const { state, now } = useDialogs(daemon);
  const native = (state?.dialogs ?? []).filter((d) => d.native);
  if (native.length > 0) {
    return (
      <div className="native-dialog-banner" role="region" aria-label="Windows dialog in the editor">
        {native.map((d) => <DialogCard key={d.id} dialog={d} now={now()} />)}
      </div>
    );
  }
  const first = state?.dialogs[0];
  return first ? <DialogBannerLine dialog={first} now={now()} /> : null;
}
