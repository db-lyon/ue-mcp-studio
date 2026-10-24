import { useEffect, useState, type KeyboardEvent } from "react";
import { SLASH_COMMANDS, matchCommands, slashQuery, type SlashCommand } from "@ue-mcp-studio/shared";

export const SLASH_MENU_ID = "slash-menu";

/**
 * The slash command menu: open while the message is a slash and the start of
 * a command's name. Up and Down move through it, Enter or Tab picks (the name
 * goes into the message, ready for its text), Escape closes it until the
 * message changes. `keyDown` returns true when the menu took the key.
 */
export function useSlashMenu(draft: string, onDraft: (text: string) => void, commands: readonly SlashCommand[] = SLASH_COMMANDS) {
  const query = slashQuery(draft);
  const items: SlashCommand[] = query === null ? [] : matchCommands(query, commands);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  useEffect(() => setActive(0), [query]);
  const open = items.length > 0 && closedAt !== draft;
  const index = Math.min(active, Math.max(0, items.length - 1));
  const pick = (c: SlashCommand) => onDraft(`/${c.name} `);
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
      <ul className="slash-menu" id={SLASH_MENU_ID} role="listbox" aria-label="Commands">
        {items.map((c, i) => (
          <li
            key={c.name}
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
            <span className="slash-name">/{c.name}</span>
            {c.args && <span className="slash-args dim">{c.args}</span>}
            <span className="slash-summary dim small">{c.summary}</span>
          </li>
        ))}
      </ul>
    ) : null,
  };
}
