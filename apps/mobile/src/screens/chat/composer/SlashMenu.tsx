/**
 * The web client's chat/SlashMenu.tsx for the app: the slash command menu over
 * the message box. Its rows are client-core's (composer-menus.ts).
 * styles.css: .slash-menu, .slash-name, .slash-args, .slash-summary.
 */
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { SLASH_COMMANDS, type ActionListing, type FlowListing, type SlashCommand } from "@ue-mcp-studio/shared";
import { actionMenuItems, slashMenuItems, slashMenuLabel, slashPickedAlready, slashQueries, type SlashMenuItem } from "@ue-mcp-studio/client-core";
import { font, useStyles, useTheme, type Theme } from "../../../ui";

export const SLASH_MENU_ID = "slash-menu";

/** A key from the message box: the web client's KeyboardEvent, as much of it as the menus read. */
export interface MenuKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/** A row is picked on a tap. */
export const pickOn = (pick: () => void) => ({ onPress: pick });

/**
 * On a menu over the box: in a browser, a press there keeps the focus in the box, as the
 * web client's mousedown does, so the pick lands in it. A phone keeps it anyway.
 */
export const keepFocus = Platform.OS === "web" ? ({ onMouseDown: (e: { preventDefault: () => void }) => e.preventDefault() } as object) : {};

/**
 * The names a command completes (the project's flows for /flow, ue-mcp's
 * actions for /action), fetched each time the menu starts offering them.
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
 * start of an action's. A tap picks (the name goes into the message, ready for
 * its text); on a hardware keyboard Up and Down move, Enter or Tab picks and
 * Escape closes it until the message changes. `keyDown` returns true when the
 * menu took the key.
 */
export function useSlashMenu(draft: string, onDraft: (text: string) => void, commands: readonly SlashCommand[] = SLASH_COMMANDS, loadFlows?: () => Promise<FlowListing[]>, loadActions?: () => Promise<ActionListing[]>) {
  const s = useStyles(styles);
  const t = useTheme();
  const q = slashQueries(draft, commands, !!loadFlows, !!loadActions);
  const { query, flowQuery, actionQuery } = q;
  const flows = useNames(flowQuery !== null, loadFlows);
  const actions = useNames(actionQuery !== null, loadActions);
  const actionItems = useMemo(() => actionMenuItems(actionQuery, actions), [actionQuery, actions]);
  const items: SlashMenuItem[] = slashMenuItems(q, commands, flows, actionItems);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<string | null>(null);
  useEffect(() => setActive(0), [query, flowQuery, actionQuery]);
  const exact = slashPickedAlready(q, items);
  const open = items.length > 0 && closedAt !== draft && !exact;
  const index = Math.min(active, Math.max(0, items.length - 1));
  const pick = (item: SlashMenuItem) => onDraft(item.insert);
  const keyDown = (e: MenuKey): boolean => {
    if (!open) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((index + step + items.length) % items.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      pick(items[index]);
      return true;
    }
    if (e.key === "Escape") {
      setClosedAt(draft);
      return true;
    }
    return false;
  };
  return {
    open,
    keyDown,
    /** For the text box: that a list completes it. */
    a11y: open ? { accessibilityHint: `${slashMenuLabel(q)} menu open` } : {},
    menu: open ? (
      <View style={s.menu} accessibilityRole="list" accessibilityLabel={slashMenuLabel(q)} nativeID={SLASH_MENU_ID} {...keepFocus}>
        {items.map((c, i) => (
          <Pressable
            key={c.key}
            accessibilityRole="menuitem"
            accessibilityState={{ selected: i === index }}
            accessibilityLabel={c.label}
            {...pickOn(() => pick(c))}
            onHoverIn={() => setActive(i)}
            style={[s.row, i === index && { backgroundColor: t.c.panel3 }]}
          >
            <Text style={s.name}>{c.label}</Text>
            {c.args ? <Text style={s.args}>{c.args}</Text> : null}
            {c.summary ? <Text style={s.summary}>{c.summary}</Text> : null}
          </Pressable>
        ))}
      </View>
    ) : null,
  };
}

/** .slash-menu and the mention menu's box: over the message box, never over Send. */
export const menuBox = (t: Theme) => ({
  position: "absolute" as const,
  left: 16,
  right: 16,
  bottom: "100%" as const,
  marginBottom: -6,
  zIndex: 5,
  padding: 4,
  borderWidth: 1,
  borderColor: t.c.line,
  borderRadius: 8,
  backgroundColor: t.c.panel2,
  boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
});

const styles = (t: Theme) => {
  const lh = t.editor ? 1.5 : 1.55;
  return {
    menu: menuBox(t),
    row: { flexDirection: "row" as const, flexWrap: "wrap" as const, alignItems: "baseline" as const, columnGap: 10, rowGap: 4, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6 },
    name: { ...font(t, "mono", 400, t.base.size, lh), color: t.c.text },
    args: { ...font(t, "sans", 400, t.base.size, lh), color: t.c.dim },
    summary: { ...font(t, "sans", 400, 12, lh), color: t.c.dim, flexBasis: "100%" as const },
  };
};
