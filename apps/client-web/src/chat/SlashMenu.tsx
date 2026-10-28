import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { SLASH_COMMANDS, actionNameQuery, flowNameQuery, matchActions, matchCommands, matchFlows, slashQuery, type ActionListing, type FlowListing, type SlashCommand } from "@ue-mcp-studio/shared";

export const SLASH_MENU_ID = "slash-menu";

/** A row of the menu: a command, a flow's name after /flow, or an action's after /action. `insert` is the message a pick leaves. */
interface MenuItem {
  key: string;
  label: string;
  args?: string;
  summary?: string;
  insert: string;
}

/**
 * The names a command completes (the project's flows for /flow, ue-mcp's
 * actions for /action), fetched each time the menu starts offering them, so
 * a flow added to ue-mcp.yml or a plugin's actions show without a reload.
 */
function useNames<T>(open: boolean, load?: () => Promise<T[]>): T[] {
  const [names, setNames] = useState<T[]>([]);
  useEffect(() => {
    if (!open || !load) return;
    let live = true;
    load().then((f) => live && setNames(f), () => live && setNames([]));
    return () => {
      live = false;
    };
  }, [open, load]);
  return names;
}

/**
 * The slash command menu: open while the message is a slash and the start of
 * a command's name, /flow and the start of a flow's name, or /action and the
 * start of an action's (at most ACTION_MENU_ROWS of them). Up and Down move
 * through it, Enter or Tab picks (the name goes into the message, ready for
 * its text), Escape closes it until the message changes. `keyDown` returns
 * true when the menu took the key.
 */
export function useSlashMenu(draft: string, onDraft: (text: string) => void, commands: readonly SlashCommand[] = SLASH_COMMANDS, loadFlows?: () => Promise<FlowListing[]>, loadActions?: () => Promise<ActionListing[]>) {
  const query = slashQuery(draft);
  const flowQuery = loadFlows && commands.some((c) => c.name === "flow") ? flowNameQuery(draft) : null;
  const actionQuery = loadActions && commands.some((c) => c.name === "action") ? actionNameQuery(draft) : null;
  const flows = useNames(flowQuery !== null, loadFlows);
  const actions = useNames(actionQuery !== null, loadActions);
  const actionItems = useMemo(
    () => (actionQuery === null ? [] : matchActions(actionQuery, actions).map((a) => ({ key: a.name, label: a.name, summary: a.summary, insert: `/action ${a.name} ` }))),
    [actionQuery, actions],
  );
  const items: MenuItem[] = query !== null
    ? matchCommands(query, commands).map((c) => ({ key: c.name, label: `/${c.name}`, args: c.args, summary: c.summary, insert: `/${c.name} ` }))
    : flowQuery !== null
      ? matchFlows(flowQuery, flows).map((f) => ({ key: f.name, label: f.name, summary: f.description, insert: `/flow ${f.name} ` }))
      : actionItems;
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  useEffect(() => setActive(0), [query, flowQuery, actionQuery]);
  // A flow or action name typed out in full is picked already: the menu stays out of the way of Enter.
  const exact = (flowQuery !== null && items.length === 1 && items[0].label === flowQuery)
    || (actionQuery !== null && items[0]?.label.toLowerCase() === actionQuery.toLowerCase());
  const open = items.length > 0 && closedAt !== draft && !exact;
  const index = Math.min(active, Math.max(0, items.length - 1));
  const pick = (item: MenuItem) => onDraft(item.insert);
  const keyDown = (e: KeyboardEvent): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pick(items[index]);
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setClosedAt(draft);
      return true;
    }
    return false;
  };
  const optionId = (i: number) => `${SLASH_MENU_ID}-${i}`;
  return {
    open,
    keyDown,
    /** For the text box: the menu it controls and the option in focus. */
    aria: open ? { "aria-controls": SLASH_MENU_ID, "aria-activedescendant": optionId(index), "aria-autocomplete": "list" as const } : {},
    menu: open ? (
      <ul className="slash-menu" id={SLASH_MENU_ID} role="listbox" aria-label={flowQuery !== null ? "Flows" : actionQuery !== null ? "Actions" : "Commands"}>
        {items.map((c, i) => (
          <li
            key={c.key}
            id={optionId(i)}
            role="option"
            aria-selected={i === index}
            className={i === index ? "active" : undefined}
            // Before the text box blurs, so the pick lands in it.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c);
            }}
            onMouseEnter={() => setActive(i)}
          >
            <span className="slash-name">{c.label}</span>
            {c.args && <span className="slash-args dim">{c.args}</span>}
            {c.summary && <span className="slash-summary dim small">{c.summary}</span>}
          </li>
        ))}
      </ul>
    ) : null,
  };
}
