/**
 * Navigation inside one open project: a stack of screens over the sessions
 * list, with the project's connection and API for every screen on it.
 */
import { createContext, useContext } from "react";
import type { StudioApi } from "@ue-mcp-studio/client-core";
import type { Project } from "./connection";

export type Route = { name: "changes" } | { name: "change"; path: string };

export interface ProjectNav {
  project: Project;
  api: StudioApi;
  push(route: Route): void;
  pop(): void;
}

export const ProjectContext = createContext<ProjectNav | null>(null);

export function useProjectNav(): ProjectNav {
  const nav = useContext(ProjectContext);
  if (!nav) throw new Error("useProjectNav outside a project");
  return nav;
}
