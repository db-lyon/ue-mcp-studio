/**
 * A turn's review: what the turn changed, grouped as the web card groups it,
 * with Keep and Revert per item and for everything still undecided, Undo for a
 * revert, and Revert anyway for a file the owner edited after the agent. An
 * item opens to its diff: Unreal's own records for a package (the asset diff),
 * a line diff for text.
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { outcomeNote, readAll, type ReviewDiff } from "@ue-mcp-studio/client-core";
import { exportNumber, factRows, lineDiff, nodeValues, readableValue, recordsByGroup, refineAssetDiff, REVIEW_GROUPS, unifiedLines, type AssetDiff, type AssetDiffRecord, type AssetVersion, type RestoreOutcome, type ReviewItem, type TurnReview } from "@ue-mcp-studio/shared";
import { b64u } from "@ue-mcp-studio/remote";
import { useProjectNav } from "../nav";
import { CardButton, c } from "../Cards";
import { DiffView } from "../Diff";
import { Header, s as ui, Spinner } from "../ui";
import { colors, mono } from "../theme";

const STATUS: Record<ReviewItem["status"], string> = { added: "Added", modified: "Modified", deleted: "Deleted" };
const STATE: Record<ReviewItem["state"], string> = { pending: "Not decided", kept: "Kept", reverted: "Reverted" };
const fileName = (p: string): string => p.split("/").pop() || p;

export function ReviewScreen({ sessionId, review: initial }: { sessionId: string; review: TurnReview }) {
  const { api, pop, push } = useProjectNav();
  const [review, setReview] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (call: () => Promise<{ review: TurnReview; outcome?: RestoreOutcome }>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    call()
      .then(
        (r) => {
          setReview(r.review);
          setNote(r.outcome ? outcomeNote(r.outcome) : null);
        },
        (e: Error) => setError(e.message),
      )
      .finally(() => setBusy(false));
  };
  const keep = (paths: string[]) => run(() => api.reviewKeep(sessionId, review.id, paths));
  const revert = (paths: string[], force = false) => run(() => api.reviewRevert(sessionId, review.id, paths, force));
  const undo = (path: string) => run(() => api.reviewUndo(sessionId, review.id, path));
  const revertAnyway = (it: ReviewItem) =>
    Alert.alert("Revert anyway?", `${fileName(it.path)} was edited after the agent changed it. Reverting puts back the version from before the turn and loses those edits.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Revert anyway", style: "destructive", onPress: () => revert([it.path], true) },
    ]);

  const pending = review.items.filter((i) => i.state === "pending" && !i.conflict).map((i) => i.path);
  const groups = useMemo(() => REVIEW_GROUPS.map((g) => ({ ...g, items: review.items.filter((i) => i.group === g.group) })).filter((g) => g.items.length), [review]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={ui.page}>
      <Header title="Review changes" back="Session" onBack={pop} />
      <Text style={ui.sub}>
        {review.items.length === 1 ? "1 change" : `${review.items.length} changes`} from this turn. Keep what you want, revert the rest.
      </Text>
      {review.dirty?.length ? (
        <View style={[ui.banner, { marginTop: 10 }]}>
          <Text style={{ color: colors.warnText }}>{review.dirty.length === 1 ? "1 package was" : `${review.dirty.length} packages were`} still unsaved after the turn, so this review cannot cover them.</Text>
        </View>
      ) : null}
      {pending.length > 1 ? (
        <View style={[c.actions, { marginTop: 10 }]}>
          <CardButton title={`Keep all ${pending.length}`} primary disabled={busy} onPress={() => keep(pending)} />
          <CardButton title={`Revert all ${pending.length}`} disabled={busy} onPress={() => revert(pending)} />
        </View>
      ) : null}
      {note ? <Text style={[ui.sub, { color: colors.warnText, marginTop: 8 }]}>{note}</Text> : null}
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {busy ? <Spinner /> : null}
      {groups.map((g) => (
        <View key={g.group}>
          <Text style={ui.section}>{g.label}</Text>
          {g.items.map((it) => (
            <View key={it.path} style={r.item}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Open ${fileName(it.path)}`} onPress={() => push({ name: "reviewItem", sessionId, reviewId: review.id, path: it.path })}>
                <View style={r.itemHead}>
                  <Text style={[ui.name, { flex: 1 }]} numberOfLines={1}>
                    {fileName(it.path)}
                  </Text>
                  <Text style={[ui.sub, it.state === "reverted" && { color: colors.warnText }, it.state === "kept" && { color: colors.ok }]}>{STATE[it.state]}</Text>
                </View>
                <Text style={ui.sub} numberOfLines={1}>
                  {STATUS[it.status]}
                  {it.untracked ? ", outside the agent's calls" : ""}
                  <Text style={{ fontFamily: mono, fontSize: 11 }}>  {it.path}</Text>
                </Text>
                {it.summary ? <Text style={[ui.sub, { color: colors.text, marginTop: 4 }]}>{it.summary}</Text> : null}
                {it.diffError ? <Text style={[ui.sub, { color: colors.dangerText }]}>Diff failed: {it.diffError}</Text> : null}
              </Pressable>
              {it.conflict && it.state !== "reverted" ? <Text style={[ui.sub, { color: colors.warnText, marginTop: 4 }]}>Edited after the agent changed it. Revert would lose those edits.</Text> : null}
              <View style={c.actions}>
                {it.state === "pending" ? (
                  <>
                    <CardButton title="Keep" label={`Keep ${fileName(it.path)}`} disabled={busy} onPress={() => keep([it.path])} />
                    {it.conflict ? <CardButton title="Revert anyway" label={`Revert ${fileName(it.path)} anyway`} disabled={busy} onPress={() => revertAnyway(it)} /> : <CardButton title="Revert" label={`Revert ${fileName(it.path)}`} disabled={busy} onPress={() => revert([it.path])} />}
                  </>
                ) : it.state === "reverted" && it.undo ? (
                  <CardButton title="Undo revert" label={`Undo the revert of ${fileName(it.path)}`} disabled={busy} onPress={() => undo(it.path)} />
                ) : it.state === "kept" ? (
                  <CardButton title="Revert" label={`Revert ${fileName(it.path)}`} disabled={busy} onPress={() => (it.conflict ? revertAnyway(it) : revert([it.path]))} />
                ) : null}
              </View>
            </View>
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

/** A property record's name: its group, then the property as the details panel labels it. */
function recordName(rec: AssetDiffRecord): string {
  return (rec as AssetDiffRecord & { label?: string }).label ?? rec.path ?? rec.displayString;
}

function valueText(v: string | null | undefined): string {
  if (v === null || v === undefined) return "none";
  return readableValue(v) ?? exportNumber(v);
}

export function ReviewItemScreen({ sessionId, reviewId, path }: { sessionId: string; reviewId: string; path: string }) {
  const { api, pop } = useProjectNav();
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.reviewDiff(sessionId, reviewId, path).then(
      (d) => live && setDiff(d),
      (e: Error) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [api, sessionId, reviewId, path]);

  const change = diff?.change;
  const asset = change?.assetDiff ? refineAssetDiff(change.assetDiff) : null;
  const text = change?.diff ? unifiedLines(change.diff) : diff && (diff.before !== undefined || diff.after !== undefined) ? lineDiff(diff.before ?? "", diff.after ?? "") : null;

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={ui.page}>
      <Header title={fileName(path)} back="Review" onBack={pop} />
      <Text style={[ui.sub, { fontFamily: mono, fontSize: 11 }]} selectable>
        {path}
      </Text>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {!diff && !error ? (
        <View style={{ marginTop: 24 }}>
          <Spinner />
        </View>
      ) : null}
      {change ? <Text style={[ui.sub, { marginTop: 6 }]}>{STATUS[change.status]}{change.untracked ? ". Changed outside the agent's calls" : ""}</Text> : null}
      {asset ? <AssetDiffView diff={asset} /> : null}
      {text ? (
        text.length ? (
          <DiffView lines={text} label={`Changes to ${fileName(path)}`} />
        ) : (
          <Text style={[ui.sub, { marginTop: 12 }]}>No line differs.</Text>
        )
      ) : null}
      {diff && !asset && !text ? <Text style={[ui.sub, { marginTop: 12 }]}>{change?.large ? "A large file: kept as a copy, with no line diff." : "No diff for this file."}</Text> : null}
    </ScrollView>
  );
}

function AssetDiffView({ diff: d }: { diff: AssetDiff }) {
  if (d.state === "error") return <Text style={[ui.error, { marginTop: 12 }]}>The diff failed: {d.error ?? "no reason given"}</Text>;
  if (d.state === "deferred") return <Text style={[ui.sub, { marginTop: 12 }]}>This package was over the per-turn diff limit. Open it in Studio on your computer to diff it.</Text>;
  const facts = factRows(d.before, d.after).filter((f) => f.changed);
  return (
    <View style={{ marginTop: 12, gap: 8 }}>
      <Text style={ui.body}>{d.summary}</Text>
      <Pictures before={d.before} after={d.after} />
      {d.engine?.note ? <Text style={ui.sub}>{d.engine.note}</Text> : null}
      {facts.length ? (
        <View>
          <Text style={ui.section}>Facts</Text>
          {facts.map((f) => (
            <Change key={f.name} name={f.name} before={f.before} after={f.after} />
          ))}
        </View>
      ) : null}
      {(d.sections ?? []).map((sec, i) => {
        const visible = sec.entries.filter((e) => !e.hidden);
        if (!visible.length && !sec.hiddenChanges) return null;
        return (
          <View key={`${sec.category}-${i}`}>
            <Text style={ui.section}>{sec.category}</Text>
            {recordsByGroup(visible).map((g, gi) => (
              <View key={gi} style={{ marginBottom: 6 }}>
                {g.group ? <Text style={[ui.name, { marginTop: 4 }]}>{g.group}</Text> : null}
                {g.entries.map((rec, ri) => (
                  <Record key={ri} rec={rec} />
                ))}
              </View>
            ))}
            {sec.hiddenChanges ? <Text style={ui.sub}>{sec.hiddenChanges === 1 ? "1 change" : `${sec.hiddenChanges} changes`} under properties the details panel does not show.</Text> : null}
          </View>
        );
      })}
      {d.textDiff ? <DiffView lines={unifiedLines(d.textDiff.diff)} label={`${d.textDiff.format} diff`} /> : null}
      {d.recordsDropped ? <Text style={ui.sub}>{d.recordsDropped} more records not shown.</Text> : null}
    </View>
  );
}

function Record({ rec }: { rec: AssetDiffRecord }) {
  if (rec.path && (rec.before !== undefined || rec.after !== undefined)) {
    if (rec.diffType === "PropertyAddedToB") return <Change name={recordName(rec)} after={valueText(rec.after)} note="added" />;
    if (rec.diffType === "PropertyAddedToA") return <Change name={recordName(rec)} before={valueText(rec.before)} note="removed" />;
    return <Change name={recordName(rec)} before={valueText(rec.before)} after={valueText(rec.after)} />;
  }
  const node = rec.node1 ?? rec.node2;
  const values = nodeValues(node);
  return (
    <View style={r.record}>
      <Text style={ui.body}>{rec.displayString}</Text>
      {values.map((v) => (
        <Text key={v.name} style={ui.sub}>
          {v.name}: {v.value}
        </Text>
      ))}
      {(rec.properties ?? []).map((p, i) => (
        <Record key={i} rec={p} />
      ))}
    </View>
  );
}

function Change({ name, before, after, note }: { name: string; before?: string; after?: string; note?: string }) {
  return (
    <View style={r.record} accessibilityLabel={`${name}: ${before ?? "none"} to ${after ?? "none"}`}>
      <Text style={ui.name}>
        {name}
        {note ? <Text style={ui.sub}> ({note})</Text> : null}
      </Text>
      {before !== undefined ? (
        <Text style={[r.value, r.before]} selectable>
          {before}
        </Text>
      ) : null}
      {after !== undefined ? (
        <Text style={[r.value, r.after]} selectable>
          {after}
        </Text>
      ) : null}
    </View>
  );
}

/** The before and after pictures of a package, fetched through the sealed transport. */
function Pictures({ before, after }: { before?: AssetVersion | null; after?: AssetVersion | null }) {
  const sides = [
    { label: "Before", v: before },
    { label: "After", v: after },
  ].filter((x) => x.v?.thumbnail && "id" in x.v.thumbnail);
  if (!sides.length) return null;
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {sides.map((x) => (
        <Picture key={x.label} label={x.label} url={`/v1/ext/studio/review/thumbnails/${encodeURIComponent((x.v!.thumbnail as { id: string }).id)}`} />
      ))}
    </View>
  );
}

function Picture({ label, url }: { label: string; url: string }) {
  const { project } = useProjectNav();
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    project
      .transport("GET", url, { headers: { accept: "image/*" } })
      .then(async (reply) => {
        const bytes = await readAll(reply);
        if (!live) return;
        if (reply.status !== 200 || !bytes.length) return setFailed(true);
        const b64 = b64u(bytes as Uint8Array<ArrayBuffer>).replace(/-/g, "+").replace(/_/g, "/");
        setSrc(`data:${reply.headers["content-type"] ?? "image/png"};base64,${b64}${"=".repeat((4 - (b64.length % 4)) % 4)}`);
      })
      .catch(() => live && setFailed(true));
    return () => void (live = false);
  }, [project, url]);
  return (
    <View style={{ flex: 1 }}>
      <Text style={ui.sub}>{label}</Text>
      {src ? <Image source={{ uri: src }} style={r.picture} resizeMode="contain" accessibilityLabel={`${label} picture`} /> : <View style={[r.picture, { alignItems: "center", justifyContent: "center" }]}>{failed ? <Text style={ui.sub}>No picture</Text> : <Spinner />}</View>}
    </View>
  );
}

const r = StyleSheet.create({
  item: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingVertical: 10 },
  itemHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  record: { paddingVertical: 4, gap: 2 },
  value: { fontFamily: mono, fontSize: 12, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  before: { backgroundColor: colors.diffDel, color: colors.dangerText },
  after: { backgroundColor: colors.diffAdd, color: colors.ok },
  picture: { width: "100%", aspectRatio: 1, backgroundColor: colors.code, borderRadius: 8, borderWidth: 1, borderColor: colors.border, marginTop: 4 },
});
