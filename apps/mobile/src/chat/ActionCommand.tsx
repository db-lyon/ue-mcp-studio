/**
 * The web client's chat/ActionCommand.tsx for the app: what a /action message
 * opens above the composer. The form's rules are the shared package's actions.ts.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  actionArgs,
  actionFormFields,
  actionPrefill,
  closestNames,
  flowValue,
  parseActionArgs,
  splitActionName,
  type ActionDescription,
  type ActionListing,
  type ActionRunRequest,
} from "@ue-mcp-studio/shared";
import { useProjectNav } from "../nav";
import { Banner } from "../ui";
import { CloseRow, LauncherCard, LauncherText, NameRow } from "./FlowCommand";
import { FieldsForm } from "./Forms";

type Loaded =
  | { kind: "loading" }
  | { kind: "unnamed" }
  | { kind: "unknown"; closest: string[] }
  | { kind: "error"; message: string }
  | { kind: "ready"; listing: ActionListing | null; description: ActionDescription };

/**
 * What a /action message opens above the composer: the action's parameters as
 * a form, the pairs typed after the name filled in. An action that takes no
 * parameters runs at once. A name that is no action shows the closest ones.
 * Running it is the user's own call: the agent's approval rules still apply,
 * so a destructive action can stop at an approval card.
 */
export function ActionLauncher({ text, run, onClose }: { text: string; run: (request: ActionRunRequest) => Promise<unknown>; onClose: () => void }) {
  const { api } = useProjectNav();
  const parsed = useMemo(() => parseActionArgs(text.replace(/^\s*\/action\b/, "")), [text]);
  const [name, setName] = useState(parsed.name);
  const typed = name === parsed.name ? parsed.values : {};
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canonical, setCanonical] = useState(name);

  const start = (full: string, args: Record<string, unknown>) => {
    const parts = splitActionName(full);
    if (!parts) return;
    setSent(true);
    setError(null);
    run({ ...parts, args }).then(onClose, (e: Error) => {
      setSent(false);
      setError(e.message);
    });
  };

  useEffect(() => {
    let live = true;
    const stop = () => {
      live = false;
    };
    setLoaded({ kind: name ? "loading" : "unnamed" });
    if (!name) return stop;
    const listed = api.actions().then((r) => r.actions, () => null);
    void listed.then(async (actions) => {
      if (!live) return;
      // The catalog's own spelling of the name, whatever case it was typed in.
      const listing = actions?.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
      if (actions && !listing) return setLoaded({ kind: "unknown", closest: closestNames(name, actions.map((a) => a.name)) });
      const full = listing?.name ?? name;
      if (!splitActionName(full)) return setLoaded({ kind: "unknown", closest: actions ? closestNames(name, actions.map((a) => a.name)) : [] });
      let description: ActionDescription;
      try {
        description = await api.describeAction(full);
      } catch (e) {
        if (live) setLoaded({ kind: "error", message: e instanceof Error ? e.message : String(e) });
        return;
      }
      if (!live) return;
      setCanonical(full);
      setLoaded({ kind: "ready", listing, description });
      // Nothing to ask: it runs as it is.
      if (description.params.length === 0) start(full, Object.fromEntries(Object.entries(typed).map(([k, v]) => [k, flowValue(v, null)])));
    });
    return stop;
  }, [name]);

  const title = name ? `Run action ${loaded.kind === "ready" ? canonical : name}` : "Run an action";
  let body: ReactNode;
  if (loaded.kind === "loading") body = <LauncherText dim status>Reading the action</LauncherText>;
  else if (loaded.kind === "unnamed") {
    body = (
      <>
        <LauncherText>Name an action after /action, as category.method: /action level.get_outliner. The menu completes the name as you type it.</LauncherText>
        <CloseRow onClose={onClose} />
      </>
    );
  } else if (loaded.kind === "unknown") {
    body = (
      <>
        <LauncherText>No action named {name}.</LauncherText>
        {loaded.closest.length > 0 && <NameRow names={loaded.closest} closest onPick={setName} />}
        <CloseRow onClose={onClose} />
      </>
    );
  } else if (loaded.kind === "error") {
    body = (
      <>
        <Banner kind="bad">{loaded.message}</Banner>
        <CloseRow onClose={onClose} />
      </>
    );
  } else if (loaded.description.params.length === 0) {
    body = error ? <><Banner kind="bad">{error}</Banner><CloseRow onClose={onClose} /></> : <LauncherText dim status>Starting</LauncherText>;
  } else {
    const d = loaded.description;
    const { fields, required } = actionFormFields(d);
    const prefill = Object.fromEntries(Object.entries(typed).filter(([k]) => k in fields).map(([k, v]) => [k, actionPrefill(v, fields[k])]));
    const line = loaded.listing?.summary;
    body = (
      <>
        {line ? <LauncherText>{line}</LauncherText> : null}
        {loaded.listing?.destructive ? <LauncherText dim>ue-mcp marks this action as deleting or overwriting. Your approval settings decide whether it asks first.</LauncherText> : null}
        <FieldsForm
          key={canonical}
          fields={fields}
          required={required}
          prefill={prefill}
          sent={sent}
          error={error}
          submitLabel="Run"
          declineLabel="Cancel"
          requireFilled
          onSubmit={(content) => start(canonical, actionArgs(d, content, typed))}
          onDecline={onClose}
        />
      </>
    );
  }
  return (
    <LauncherCard region="Run an action" title={title} command="/action">
      {body}
    </LauncherCard>
  );
}
