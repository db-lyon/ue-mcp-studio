// The source control chip at the foot of the navigation drawer, as the shell mounts it (web: chat/VcsChip.tsx). It follows the session events itself.
import { VcsChip as Chip } from "../screens/git/VcsChip";

export function VcsChip(_props: { events?: unknown[] }) {
  return <Chip />;
}
