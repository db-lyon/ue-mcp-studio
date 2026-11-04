/** share.tsx on the web harness and in tests: nothing is ever shared in. */
import type { ReactNode } from "react";
import type { Shared } from "./share";

export type { Shared, SharedFile } from "./share";

export function ShareProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

const NONE: Shared = { files: [], text: null, consume: () => undefined };
export function useSharedFiles(): Shared {
  return NONE;
}
