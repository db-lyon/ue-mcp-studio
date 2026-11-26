/**
 * Performers: what a track drives (the editor's player, a remote client, or
 * an actor in the level), as the Arrangement's track headers and the piano
 * roll's lanes show and pick them. The daemon lists the candidates
 * (GET /hub/performers) and checks a clip's lanes against its track's
 * performer; this is the reading, naming and text form both clients share
 * (db-lyon/ue-mcp issue 2137).
 */
import { PERFORMER_CAPABILITIES, PERFORMERS_FEATURE } from "@ue-mcp-studio/shared";
import type { ArrangementFinding, LaneCapability, Performer, PerformerCandidate, PerformersView, SetAnswer, SetRunScope } from "@ue-mcp-studio/shared";

/** Whether the daemon's tracks drive performers (GET /hub/performers and the track.performer op). */
export function performersOn(health: unknown): boolean {
  const features = Array.isArray(health) ? health : (health as { features?: unknown } | null)?.features;
  return Array.isArray(features) && features.includes(PERFORMERS_FEATURE);
}

/** The performer a track drives: its `performer`, or player `player` from a daemon that predates performers. */
export const performerOfTrack = (t: { performer?: Performer | null; player: number }): Performer => t.performer ?? { kind: "player", client: t.player };

/** The text form the set's op lines take: `player:N`, or `actor:<name>`, quoted when the name holds a space or a quote. */
export function performerText(p: Performer): string {
  if (p.kind === "player") return `player:${p.client}`;
  return /[\s"\\]/.test(p.actor) ? `actor:"${p.actor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : `actor:${p.actor}`;
}

/** One key per performer, equal for two references to the same one. */
export const performerId = (p: Performer): string => (p.kind === "player" ? `player:${p.client}` : `actor:${p.actor.toLowerCase()}`);

/**
 * A performer as a person types it: `player:N` or a bare number for a
 * player, `actor:<name>` or any other name for an actor. Null when empty.
 */
export function parsePerformer(text: string): Performer | null {
  const t = text.trim().replace(/^"(.*)"$/, "$1");
  if (!t) return null;
  if (/^\d+$/.test(t)) return { kind: "player", client: Number(t) };
  const player = /^player:\s*(\d+)$/i.exec(t);
  if (player) return { kind: "player", client: Number(player[1]) };
  const actor = /^actor:\s*(.+)$/i.exec(t);
  const name = (actor ? actor[1] : t).trim().replace(/^"(.*)"$/, "$1");
  return name ? { kind: "actor", actor: name } : null;
}

/**
 * A performer from a typed name: a candidate's label or name ("Editor",
 * "Client 2", an actor's label), else the text form parsePerformer reads.
 * Null when empty.
 */
export function resolvePerformer(text: string, candidates: readonly PerformerCandidate[] = []): Performer | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const hit = candidates.find((c) => c.label.toLowerCase() === t || PERFORMER_COPY.name(c.performer).toLowerCase() === t);
  if (hit) return hit.performer;
  if (t === "editor" || t === "editor player") return { kind: "player", client: 0 };
  const client = /^client\s+(\d+)$/.exec(t);
  if (client) return { kind: "player", client: Number(client[1]) };
  return parsePerformer(text);
}

/** Whether a performer takes lanes of this capability. */
export const takesLane = (p: Performer, capability: LaneCapability): boolean => PERFORMER_CAPABILITIES[p.kind].includes(capability);

/** The players a picker offers when the daemon cannot list them: the editor and clients 1 to 3, as GET /hub/performers lists them. */
export const fallbackPlayers = (): PerformerCandidate[] =>
  [0, 1, 2, 3].map((client) => ({ performer: { kind: "player", client }, label: PERFORMER_COPY.name({ kind: "player", client }), capabilities: [...PERFORMER_CAPABILITIES.player] }));

/**
 * The picker's two groups: players, then actors with pawns first. The
 * current performer is kept in its group when the list does not hold it (an
 * actor of a level that is not open, or a client above 3).
 */
export function performerGroups(view: PerformersView | null, current?: Performer | null): { players: PerformerCandidate[]; actors: PerformerCandidate[] } {
  const all = view?.performers?.length ? view.performers : fallbackPlayers();
  const players = all.filter((c) => c.performer.kind === "player");
  const actors = all.filter((c) => c.performer.kind === "actor").map((c, i) => ({ c, i })).sort((a, b) => Number(!!b.c.pawn) - Number(!!a.c.pawn) || a.i - b.i).map((x) => x.c);
  if (current && !all.some((c) => performerId(c.performer) === performerId(current))) {
    const kept: PerformerCandidate = { performer: current, label: PERFORMER_COPY.name(current), capabilities: [...PERFORMER_CAPABILITIES[current.kind]] };
    (current.kind === "player" ? players : actors).unshift(kept);
  }
  return { players, actors };
}

/**
 * The finding ids a performer finding can carry, as the Arrangement's track
 * and instance ids: "track/instance" as it is; a scene's composition,
 * "scene/N-instance", as instance `instance` on the scene's Nth track (or
 * the only track holding that instance); a run's, "N-instance" or
 * "instance", the same way within the run's tracks. Null when it names
 * neither.
 */
export function performerFindingId(id: string, set: Pick<SetAnswer, "tracks" | "scenes">, runTracks?: readonly string[]): string | null {
  const parts = id.split("/");
  const tracks = new Map(set.tracks.map((t) => [t.id, t]));
  if (parts.length === 2 && tracks.has(parts[0])) return id;
  const scene = parts.length === 2 ? set.scenes.find((s) => s.id === parts[0]) : undefined;
  const local = parts.length === 2 ? parts[1] : parts[0];
  const within = scene ? scene.tracks : runTracks ?? set.tracks.map((t) => t.id);
  if (!scene && parts.length === 2) return null;
  const m = /^(\d+)-(.+)$/.exec(local);
  const inst = m ? m[2] : local;
  const holds = (t: string) => !!tracks.get(t)?.arrangement.instances.some((i) => i.id === inst);
  const nth = m ? within[Number(m[1]) - 1] : undefined;
  if (nth && holds(nth)) return `${nth}/${inst}`;
  const holding = within.filter(holds);
  return holding.length === 1 ? `${holding[0]}/${inst}` : null;
}

/**
 * Findings with their performer findings placed on the instance they are
 * about, so the Arrangement flags the block: a scene's or a run's
 * composition ids become "track/instance". Others are left as they are.
 * Duplicates of one finding on one instance are kept once.
 */
export function placePerformerFindings(findings: readonly ArrangementFinding[], set: Pick<SetAnswer, "tracks" | "scenes">, runTracks?: readonly string[]): ArrangementFinding[] {
  const seen = new Set<string>();
  const out: ArrangementFinding[] = [];
  for (const f of findings) {
    const id = f.field === "performer" ? performerFindingId(f.id, set, runTracks) ?? f.id : f.id;
    const key = `${id}|${f.field}|${f.message.replace(/^\S+: /, "")}`;
    if (f.field === "performer" && seen.has(key)) continue;
    seen.add(key);
    out.push(id === f.id ? f : { ...f, id, message: f.message.replace(/^\S+: /, "") });
  }
  return out;
}

/**
 * The tracks a run of this scope plays, in the order its composition numbers
 * them: the track itself; an arrangement's tracks that sound (the soloed
 * ones when any is soloed, else every one not muted) in their order; a
 * scene's own list.
 */
export function runTracksOf(scope: SetRunScope, set: Pick<SetAnswer, "tracks" | "scenes">): string[] {
  if (scope.kind === "track") return [scope.goalId];
  if (scope.kind === "scene") return set.scenes.find((s) => s.id === scope.goalId)?.tracks ?? [];
  const sorted = [...set.tracks].sort((a, b) => a.order - b.order);
  const solo = sorted.filter((t) => t.solo);
  return (solo.length ? solo : sorted.filter((t) => !t.mute)).map((t) => t.id);
}

// ---------- Copy ----------

export const PERFORMER_COPY = {
  /** A performer's name: "Editor", "Client 2", or the actor's own name. */
  name: (p: Performer): string => (p.kind === "player" ? (p.client === 0 ? "Editor" : `Client ${p.client}`) : p.actor),
  /** The name as the narrow track header shows it, with the full name on hover. */
  short: (p: Performer): string => (p.kind === "player" ? (p.client === 0 ? "Ed" : `C${p.client}`) : p.actor),
  kind: (p: Performer): string => (p.kind === "player" ? "Player" : "Actor"),
  /** The marker before the name in a track header: P for a player, A for an actor. */
  marker: (p: Performer): string => (p.kind === "player" ? "P" : "A"),
  hint: "What this track drives: a player, or an actor in the level",
  pickFor: (title: string) => `Performer for ${title}`,
  newTrackFor: "Add a track for a performer",
  newTrackTitle: "New track for",
  players: "Players",
  actors: (level: string | null) => (level ? `Actors in ${level.split("/").pop()}` : "Actors"),
  pawn: "Pawn",
  loading: "Reading the level's actors",
  noActors: (reason: string) => `No actors listed: ${reason}`,
  failed: (why: string) => `The level's actors could not be listed: ${why}`,
  takes: (caps: readonly LaneCapability[]) => `Takes ${caps.length > 1 ? `${caps.slice(0, -1).join(", ")} and ${caps[caps.length - 1]}` : caps[0] ?? "no"} lanes`,
};

/** A lane capability's name. */
export const LANE_KIND_LABEL: Record<LaneCapability, string> = { input: "Input", move: "Move to", action: "Actions", value: "Value" };
