/**
 * The ways out of an open project: back to Projects, and pairing again. The
 * shell provides them; a screen that covers the header (the connection
 * overlay) reads them so it never traps the user in a project that is away.
 */
import { createContext } from "react";

export const Exits = createContext<{ name: string; onBack: () => void; onPair?: () => void }>({ name: "", onBack: () => undefined });
