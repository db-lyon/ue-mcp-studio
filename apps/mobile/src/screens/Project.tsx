import { useEffect, useMemo, useState } from "react";
import { BackHandler, View } from "react-native";
import { studioApi, type PanelLocation, type Transport } from "@ue-mcp-studio/client-core";
import { useLockView, useProject, type Project } from "../connection";
import type { Device } from "../relay";
import { PinPad } from "../PinPad";
import { AppShell } from "../AppShell";
import { ChangeScreen, ChangesScreen } from "./Changes";
import { ProjectContext, type ProjectNav, type Route } from "../nav";

export function ProjectScreen({ device, onBack, onUnpaired, transport, initial }: { device: Device; onBack: () => void; onUnpaired: (message: string) => void; transport?: Transport; initial?: PanelLocation }) {
  const project = useProject(device, transport);
  const [stack, setStack] = useState<Route[]>([]);
  const api = useMemo(() => studioApi(project.transport), [project.transport]);
  const nav = useMemo<ProjectNav>(() => ({ project, api, push: (r) => setStack((s) => [...s, r]), pop: () => setStack((s) => s.slice(0, -1)) }), [project, api]);
  const top = stack[stack.length - 1];

  // Android back pops the project's own stack first; registered after the app's handler, so it runs first.
  useEffect(() => {
    if (!top) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => (nav.pop(), true));
    return () => sub.remove();
  }, [top, nav]);

  return (
    <ProjectContext.Provider value={nav}>
      <View style={{ flex: 1 }} onTouchStart={() => project.lock.touched()}>
        {!top ? <AppShell initialSession={initial?.tab === "Chat" ? (initial.session ?? null) : null} onBack={onBack} /> : null}
        {top?.name === "changes" ? <ChangesScreen /> : null}
        {top?.name === "change" ? <ChangeScreen path={top.path} /> : null}
        <Lock project={project} onUnpaired={onUnpaired} />
      </View>
    </ProjectContext.Provider>
  );
}

function Lock({ project, onUnpaired }: { project: Project; onUnpaired: (message: string) => void }) {
  const lockView = useLockView(project.lock);
  return (
    <>
      {lockView.screen || lockView.prompt || lockView.removed ? <PinPad lock={project.lock} view={lockView} onRemoved={() => onUnpaired("This phone was removed after too many wrong PINs. Pair it again.")} /> : null}
    </>
  );
}
