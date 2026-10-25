/**
 * What a run spent, read from the Claude transcripts it wrote, and the table
 * per prompt per client. Cost is input-equivalent tokens: input x1, 5-minute
 * cache write x1.25, 1-hour cache write x2, cache read x0.1, output x5, each
 * assistant message counted once by its id across the main transcript and
 * its subagents.
 *
 * node report.mjs <results.jsonl> prints the tables for a run already made.
 */
import fs from "node:fs";
import path from "node:path";

function transcripts(files) {
  const all = [];
  for (const f of files) {
    all.push(f);
    const sub = path.join(f.replace(/\.jsonl$/, ""), "subagents");
    if (fs.existsSync(sub)) for (const x of fs.readdirSync(sub)) if (x.endsWith(".jsonl")) all.push(path.join(sub, x));
  }
  return all;
}

export function spend(files) {
  const msgs = new Map();
  const ue = { search: 0, describe: 0, call: 0 };
  const results = {};
  const kind = new Map();
  for (const f of transcripts(files)) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      const m = j.message;
      if (j.type === "assistant" && m?.id) {
        const prev = msgs.get(m.id);
        const u = m.usage ?? {};
        msgs.set(m.id, { ...(prev ?? {}), ...u, output_tokens: Math.max(prev?.output_tokens ?? 0, u.output_tokens ?? 0) });
      }
      for (const b of Array.isArray(m?.content) ? m.content : []) {
        if (b?.type === "tool_use" && !kind.has(b.id)) {
          const n = b.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
          const a = b.input?.action;
          if ((n === "ue_mcp" || n === "tools") && a in ue) ue[a]++;
          kind.set(b.id, n === "ue_mcp" || n === "tools" ? `ue.${a}` : n);
        }
        if (b?.type === "tool_result" && !results[b.tool_use_id]) {
          const len = typeof b.content === "string" ? b.content.length : JSON.stringify(b.content ?? "").length;
          results[b.tool_use_id] = { kind: kind.get(b.tool_use_id) ?? "?", len };
        }
      }
    }
  }
  const t = { calls: msgs.size, input: 0, write5m: 0, write1h: 0, read: 0, output: 0 };
  for (const u of msgs.values()) {
    const cw = u.cache_creation_input_tokens ?? 0;
    const c5 = u.cache_creation?.ephemeral_5m_input_tokens;
    const c1 = u.cache_creation?.ephemeral_1h_input_tokens;
    t.input += u.input_tokens ?? 0;
    if (c5 === undefined && c1 === undefined) t.write5m += cw;
    else {
      t.write5m += c5 ?? 0;
      t.write1h += c1 ?? 0;
    }
    t.read += u.cache_read_input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
  }
  const byKind = {};
  for (const r of Object.values(results)) {
    byKind[r.kind] ??= { n: 0, chars: 0 };
    byKind[r.kind].n++;
    byKind[r.kind].chars += r.len;
  }
  const cost = t.input + 1.25 * t.write5m + 2 * t.write1h + 0.1 * t.read + 5 * t.output;
  return { ...t, ue, results: byKind, cost: Math.round(cost) };
}

const k = (n) => (n / 1000).toFixed(1);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function report(runs) {
  const lines = ["## Runs", "", "| client | prompt | wall s | model calls | cache write | cache read | output | ue search/describe/call | cost k | task | largest results |", "|---|---|---|---|---|---|---|---|---|---|---|"];
  const groups = new Map();
  for (const r of runs) {
    if (!r.files?.length) {
      lines.push(`| ${r.client} | ${r.prompt} | | | | | | | | no transcript: ${r.error ?? ""} | |`);
      continue;
    }
    const s = spend(r.files);
    const big = Object.entries(s.results).sort((a, b) => b[1].chars - a[1].chars).slice(0, 3).map(([n, v]) => `${n} ${v.n}x ${k(v.chars)}k`).join(", ");
    const task = r.verify?.ok ? "ok" : `FAILED ${(r.verify?.failed ?? []).map((f) => f.name).join("; ") || r.verify?.error || ""}`;
    lines.push(`| ${r.client} | ${r.prompt} | ${Math.round(r.wall ?? 0)} | ${s.calls} | ${k(s.write5m + s.write1h)} | ${k(s.read)} | ${k(s.output)} | ${s.ue.search}/${s.ue.describe}/${s.ue.call} | ${k(s.cost)} | ${task} | ${big} |`);
    const key = `${r.prompt}\t${r.client}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ cost: s.cost, ok: !!r.verify?.ok });
  }
  const cc = new Map([...groups].filter(([key]) => key.endsWith("\tcc")).map(([key, xs]) => [key.split("\t")[0], median(xs.map((x) => x.cost))]));
  const summary = ["## Per prompt", "", "| prompt | client | runs | median k | range k | median / Claude Code | worst run / Claude Code median | task success |", "|---|---|---|---|---|---|---|---|"];
  for (const [key, xs] of [...groups].sort()) {
    const [p, c] = key.split("\t");
    const costs = xs.map((x) => x.cost);
    const base = cc.get(p);
    const ratio = (v) => (base ? (v / base).toFixed(2) : "");
    summary.push(`| ${p} | ${c} | ${xs.length} | ${k(median(costs))} | ${k(Math.min(...costs))} to ${k(Math.max(...costs))} | ${ratio(median(costs))} | ${ratio(Math.max(...costs))} | ${xs.filter((x) => x.ok).length}/${xs.length} |`);
  }
  return [...summary, "", ...lines].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  const runs = fs.readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(report(runs));
}
