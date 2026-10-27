/**
 * A small YAML tokenizer for highlighting. It never fails and never drops a
 * character: the tokens' text joined is the input, so the highlighted layer
 * lines up with the textarea over it. It reads YAML well enough to colour it,
 * not to parse it.
 */
export type YamlTokenType = "key" | "string" | "number" | "bool" | "null" | "comment" | "punct" | "dash" | "anchor" | "tag" | "doc";
export interface YamlToken { type: YamlTokenType | null; text: string }

const NUMBER = /^(?:[-+]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F_]+|0o[0-7_]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/;
const NULL = /^(?:null|Null|NULL|~)$/;

/** What a plain scalar is when it is a value. */
function scalar(text: string): YamlTokenType {
  if (NUMBER.test(text)) return "number";
  if (BOOL.test(text)) return "bool";
  if (NULL.test(text)) return "null";
  return "string";
}

export function tokenizeYaml(src: string): YamlToken[] {
  const out: YamlToken[] = [];
  const push = (type: YamlTokenType | null, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };

  // State that crosses lines: the column a block scalar's parent sits at, and an open quoted string.
  let block: number | null = null;
  let quote: '"' | "'" | null = null;
  let flow = 0;

  const lines = src.split(/(\r?\n)/);
  for (let li = 0; li < lines.length; li += 2) {
    const line = lines[li];
    const eol = lines[li + 1] ?? "";
    const indent = /^ */.exec(line)![0].length;

    if (block !== null) {
      if (line.trim() === "" || indent > block) {
        push(null, line.slice(0, indent));
        push("string", line.slice(indent));
        push(null, eol);
        continue;
      }
      block = null;
    }

    let p = 0;
    // A quoted string carried over from the line above.
    if (quote) {
      const end = closeQuote(line, 0, quote);
      push("string", line.slice(0, end));
      p = end;
      if (end >= line.length && !closed(line, quote)) {
        push(null, eol);
        continue;
      }
      quote = null;
    }

    // Where a block scalar on this line would hang from: its key's column, else the last dash's, else the indent.
    let parent = indent;
    let atNode = p === 0;
    while (p < line.length) {
      const rest = line.slice(p);
      const ch = line[p];
      let m: RegExpExecArray | null;

      if (ch === " " || ch === "\t") {
        m = /^[ \t]+/.exec(rest)!;
        push(null, m[0]);
        p += m[0].length;
        continue;
      }
      if (ch === "#" && (p === 0 || /[ \t]/.test(line[p - 1]))) {
        push("comment", rest);
        break;
      }
      if (p === 0 && (m = /^(?:---|\.\.\.)(?=[ \t]|$)/.exec(rest))) {
        push("doc", m[0]);
        p += 3;
        atNode = true;
        continue;
      }
      if (atNode && flow === 0 && (m = /^[-?](?=[ \t]|$)/.exec(rest))) {
        push(ch === "-" ? "dash" : "punct", ch);
        parent = p;
        p += 1;
        continue;
      }
      if ((ch === "&" || ch === "*") && (m = /^[&*][^\s,[\]{}]+/.exec(rest))) {
        push("anchor", m[0]);
        p += m[0].length;
        continue;
      }
      if (ch === "!" && (m = /^![^\s,[\]{}]*/.exec(rest))) {
        push("tag", m[0]);
        p += m[0].length;
        continue;
      }
      if (ch === "[" || ch === "{") {
        flow++;
        push("punct", ch);
        p++;
        atNode = true;
        continue;
      }
      if (ch === "]" || ch === "}") {
        flow = Math.max(0, flow - 1);
        push("punct", ch);
        p++;
        continue;
      }
      if (ch === "," && flow > 0) {
        push("punct", ch);
        p++;
        atNode = true;
        continue;
      }
      if (ch === ":" && isIndicator(line, p, flow)) {
        push("punct", ":");
        p++;
        atNode = false;
        continue;
      }
      if ((ch === "|" || ch === ">") && flow === 0 && (m = /^[|>][-+0-9]*(?=[ \t]|$)/.exec(rest))) {
        push("punct", m[0]);
        p += m[0].length;
        block = parent;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const end = closeQuote(line, p + 1, ch);
        const text = line.slice(p, end);
        const done = closed(text.slice(1), ch);
        const key = done && isKeyAfter(line, end, flow);
        push(key ? "key" : "string", text);
        if (key) parent = p;
        p = end;
        if (!done) quote = ch;
        atNode = false;
        continue;
      }
      // A plain scalar: up to a comment, a key indicator, or (in flow) a flow indicator.
      const start = p;
      while (p < line.length) {
        const c = line[p];
        if (c === "#" && /[ \t]/.test(line[p - 1])) break;
        if (c === ":" && isIndicator(line, p, flow)) break;
        if (flow > 0 && /[,[\]{}]/.test(c)) break;
        p++;
      }
      const raw = line.slice(start, p);
      const text = raw.replace(/[ \t]+$/, "");
      const key = line[p] === ":" && isIndicator(line, p, flow);
      push(key ? "key" : scalar(text), text);
      if (key) parent = start;
      push(null, raw.slice(text.length));
      atNode = false;
    }
    push(null, eol);
  }
  return out;
}

/** A colon is the key indicator when space, the line's end, or (in flow) a flow indicator follows it. */
function isIndicator(line: string, p: number, flow: number): boolean {
  const next = line[p + 1];
  return next === undefined || next === " " || next === "\t" || (flow > 0 && /[,[\]{}]/.test(next));
}

function isKeyAfter(line: string, p: number, flow: number): boolean {
  const m = /^[ \t]*:/.exec(line.slice(p));
  return !!m && isIndicator(line, p + m[0].length - 1, flow);
}

/** The index just past the closing quote, or the line's end when it stays open. */
function closeQuote(line: string, from: number, q: '"' | "'"): number {
  for (let i = from; i < line.length; i++) {
    if (q === '"' && line[i] === "\\") { i++; continue; }
    if (line[i] === q) {
      if (q === "'" && line[i + 1] === "'") { i++; continue; }
      return i + 1;
    }
  }
  return line.length;
}

/** Whether a quoted run's body (opening quote removed) holds its closing quote. */
function closed(body: string, q: '"' | "'"): boolean {
  for (let i = 0; i < body.length; i++) {
    if (q === '"' && body[i] === "\\") { i++; continue; }
    if (body[i] === q) {
      if (q === "'" && body[i + 1] === "'") { i++; continue; }
      return true;
    }
  }
  return false;
}
