import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { tokenizeYaml } from "./yaml-tokens";

const INDENT = "  ";

/**
 * A YAML text box with highlighting: a transparent textarea over a <pre> with
 * the same box, font and metrics. The textarea keeps the caret, selection,
 * undo and input; the <pre> only paints, and follows the textarea's scroll.
 */
export function YamlEditor({ value, onChange, label }: { value: string; onChange: (text: string) => void; label?: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  const code = useRef<HTMLElement>(null);
  // After Escape, Tab leaves the box as usual instead of indenting.
  const release = useRef(false);
  const tokens = useMemo(() => tokenizeYaml(value), [value]);

  // The layer scrolls with the textarea and ends where the textarea's scrollbars begin.
  const follow = () => {
    const a = area.current;
    if (!a || !layer.current || !code.current) return;
    code.current.style.transform = `translate(${-a.scrollLeft}px, ${-a.scrollTop}px)`;
    layer.current.style.right = `${Math.max(0, a.offsetWidth - a.clientWidth - 2 * a.clientLeft)}px`;
    layer.current.style.bottom = `${Math.max(0, a.offsetHeight - a.clientHeight - 2 * a.clientTop)}px`;
  };
  useLayoutEffect(follow, [value]);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !area.current) return;
    const ro = new ResizeObserver(follow);
    ro.observe(area.current);
    return () => ro.disconnect();
  }, []);

  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") { release.current = true; return; }
    if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey || release.current) { release.current = false; return; }
    e.preventDefault();
    const a = e.currentTarget;
    const { selectionStart: s, selectionEnd: end } = a;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const multi = value.slice(s, end).includes("\n");
    if (!e.shiftKey && !multi) {
      // YAML indents with spaces only, so Tab writes spaces.
      edit(a, s, end, INDENT, s + INDENT.length, s + INDENT.length);
      return;
    }
    const blockEnd = end > s && value[end - 1] === "\n" ? end - 1 : end;
    const lines = value.slice(lineStart, blockEnd).split("\n");
    let first = 0;
    let total = 0;
    const next = lines.map((l, i) => {
      if (!e.shiftKey) {
        if (i === 0) first = INDENT.length;
        total += INDENT.length;
        return INDENT + l;
      }
      const cut = /^ {0,2}/.exec(l)![0].length;
      if (i === 0) first = -Math.min(cut, s - lineStart);
      total -= cut;
      return l.slice(cut);
    }).join("\n");
    edit(a, lineStart, blockEnd, next, Math.max(lineStart, s + first), end + total);
  };

  const edit = (a: HTMLTextAreaElement, from: number, to: number, text: string, selStart: number, selEnd: number) => {
    a.setSelectionRange(from, to);
    // insertText keeps the browser's undo history; where it is missing, set the value directly.
    if (!document.execCommand?.("insertText", false, text)) {
      onChange(value.slice(0, from) + text + value.slice(to));
      requestAnimationFrame(() => area.current?.setSelectionRange(selStart, selEnd));
      return;
    }
    a.setSelectionRange(selStart, selEnd);
  };

  return (
    <div className="yaml-editor">
      <pre ref={layer} className="yaml-layer" aria-hidden="true">
        <code ref={code}>
          {tokens.map((t, i) => (t.type ? <span key={i} className={`y-${t.type}`}>{t.text}</span> : t.text))}
        </code>
      </pre>
      <textarea
        ref={area}
        className="editor mono"
        aria-label={label}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        wrap="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={follow}
        onKeyDown={keyDown}
      />
    </div>
  );
}
