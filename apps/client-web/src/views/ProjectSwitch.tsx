import { SWITCH_PROJECT, SWITCH_PROJECT_LABEL } from "@ue-mcp-studio/client-core";

/**
 * A paired browser at full width: the open project as the relay lists it and
 * the way to every other one, in the top bar where the drawer has them when
 * narrow. Studio on the computer is one project and draws none of it.
 */
export function BarProjectSwitch({ name, onSwitch }: { name: string | null; onSwitch: () => void }) {
  return (
    <span className="bar-project">
      <span className="bar-project-name">{name ?? ""}</span>
      <button className="ghost bar-switch" aria-label={SWITCH_PROJECT_LABEL} onClick={onSwitch}>
        {SWITCH_PROJECT}
      </button>
    </span>
  );
}
