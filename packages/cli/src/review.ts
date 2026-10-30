// Fight review (task 47): what one hunter did in one logged fight, and where damage went missing.
// Reads the store `sim ingest` fills: the hunter's casts and failed casts, Auto Shot timing against
// the bow speed on the addon's sheet, time with no GCD or cast running, damage-over-time lost to
// deaths and early refreshes, overkill, Hunter's Mark, Aspect and pet uptime, mana, movement from
// the advanced block's positions, and the button presses the addon recorded.
//
// The log only knows what happened, not what could have: whether free GCD time or a stopped Auto
// Shot cost damage shows best next to the same fight simmed (`sim review --config`).
import type { Database } from "bun:sqlite";
import { type GameData, type Press, pressesIn, sheetsAt } from "@trueshot/data";
import { Aura, resolveEffects } from "@trueshot/engine";

export type FightRow = { id: number; file: string; hunter: string; hunterName: string; label: string; startTs: number; endTs: number; damage: number };

type Ev = {
  ts: number;
  event: string;
  src: string | null;
  dst: string | null;
  dst_name: string | null;
  spell_id: number | null;
  spell_name: string | null;
  st_guid: string | null;
  st_power_type: number | null;
  st_power: number | null;
  st_max_power: number | null;
  st_level: number | null;
  st_armor: number | null;
  st_x: number | null;
  st_y: number | null;
  amount: number | null;
  overkill: number | null;
  miss_type: string | null;
  rest: string | null;
};

export type CastRow = { name: string; casts: number; damage: number; dealsDamage: boolean; busySec: number };
export type TimelineRow = { t: number; what: string; target: string; manaPct: number | undefined; failed: string | undefined };
export type DotRow = { name: string; applied: number; ticks: number; lostToDeathSec: number; clippedSec: number; appliedSec: number };

export type FightReview = {
  fight: FightRow;
  durationSec: number;
  target: { guid: string; name: string; level: number | undefined; armor: number | undefined } | undefined;
  damage: { hunter: number; pet: number; overkill: number };
  casts: CastRow[];
  // The pet's abilities as the sim names them (Pet: Melee, Pet: Bite).
  petAbilities: { name: string; casts: number; damage: number }[];
  failures: { name: string; reason: string; count: number }[];
  timeline: TimelineRow[];
  autoShot: {
    shots: number;
    // Bow speed from the sheet, or the fastest gaps when there is none.
    speedSec: number | undefined;
    speedFromSheet: boolean;
    // Time Auto Shots came late by (each gap past the bow speed), and time with Auto Shot off
    // (gaps over STOPPED_GAPS bow speeds).
    delaySec: number;
    stoppedSec: number;
    avgDamage: number;
  };
  // Time with neither a GCD nor a cast running, inside the fight.
  freeSec: number;
  dots: DotRow[];
  uptime: { mark: number | undefined; aspects: { name: string; pct: number }[]; pet: number | undefined; dazed: number };
  mana: { startPct: number; minPct: number; endPct: number } | undefined;
  movement: { movingSec: number; yards: number; samples: number };
  presses: { name: string; presses: number; casts: number }[] | undefined;
  level: number | undefined;
};

// Casts this long before the first hit belong to the fight (Hunter's Mark, the opener).
const LEAD_MS = 5000;
// The longest an arrow is in the air.
const FLIGHT_MS = 1000;
// An Auto Shot gap over this many bow speeds had Auto Shot off for part of it.
const STOPPED_GAPS = 1.75;
// Pet attacks closer than this together count as attacking all the time between.
const PET_GAP_MS = 3000;
// Positions further apart than this in yards between two events mean the hunter moved.
const MOVED_YD = 1;
// Positions further apart in time than this say nothing about the path between them.
const POSITION_GAP_MS = 5000;
const RUN_YD_PER_SEC = 7;
// A button press counts as cast when the spell starts or goes off within this long.
const PRESS_MS = 400;

const shortName = (name: string) => name.split("-")[0]!;

export function listFights(db: Database, hunter?: string): FightRow[] {
  const rows = db
    .query<FightRow, []>(
      `SELECT f.id, f.file, f.hunter, u.name AS hunterName, f.label, f.start_ts AS startTs, f.end_ts AS endTs, f.damage
       FROM fights f JOIN units u ON u.guid = f.hunter ORDER BY f.file, f.start_ts`,
    )
    .all();
  return hunter ? rows.filter((r) => r.hunterName === hunter || r.hunter === hunter) : rows;
}

// Intervals an aura was up on a unit, from its applied, refreshed and removed lines and the unit's
// death, clipped to [from, to]; returns the covered time.
function covered(events: Ev[], match: (e: Ev) => boolean, unit: string, from: number, to: number): number {
  let since: number | undefined;
  let total = 0;
  const close = (at: number) => {
    if (since === undefined) return;
    total += Math.max(0, Math.min(at, to) - Math.max(since, from));
    since = undefined;
  };
  for (const e of events) {
    if (e.event === "UNIT_DIED" && e.dst === unit) close(e.ts);
    if (e.dst !== unit || !match(e)) continue;
    if (e.event === "SPELL_AURA_APPLIED" || e.event === "SPELL_AURA_REFRESH") since ??= e.ts;
    else if (e.event === "SPELL_AURA_REMOVED") close(e.ts);
  }
  close(to);
  return total;
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};

export function review(game: GameData, db: Database, fightId: number): FightReview {
  const fight = db
    .query<FightRow, [number]>(
      `SELECT f.id, f.file, f.hunter, u.name AS hunterName, f.label, f.start_ts AS startTs, f.end_ts AS endTs, f.damage
       FROM fights f JOIN units u ON u.guid = f.hunter WHERE f.id = ?`,
    )
    .get(fightId);
  if (!fight) throw new Error(`review: no fight ${fightId}; \`sim review\` lists them`);
  const hunter = fight.hunter;
  const pets = new Set(db.query<{ guid: string }, [string]>("SELECT guid FROM units WHERE owner = ?").all(hunter).map((u) => u.guid));
  const from = fight.startTs;
  const to = Math.max(fight.endTs, from + 1000);
  const durationSec = (to - from) / 1000;

  // Everything in the file up to well past the end: auras put up long before the pull still count,
  // and deaths after the last hit end the stings.
  const events = db
    .query<Ev, [string, number, number]>(
      `SELECT ts, event, src, dst, dst_name, spell_id, spell_name, st_guid, st_power_type, st_power, st_max_power, st_level,
        st_armor, st_x, st_y, amount, overkill, miss_type, rest
       FROM events WHERE file = ? AND ts <= ? AND (ts >= ? OR event LIKE 'SPELL_AURA_%') ORDER BY ts, id`,
    )
    .all(fight.file, to + 60_000, from - LEAD_MS);
  const inFight = (e: Ev, lead = 0) => e.ts >= from - lead && e.ts <= to;
  const mine = (e: Ev) => e.src === hunter;
  const ours = (e: Ev) => e.src === hunter || (e.src !== null && pets.has(e.src));
  const isDamage = (e: Ev) => e.event.endsWith("_DAMAGE") && !e.event.endsWith("_LANDED");
  const sheetAt = sheetsAt(db);

  // Damage, and the creature that took the most of it.
  const damage = { hunter: 0, pet: 0, overkill: 0 };
  const byTarget = new Map<string, { name: string; amount: number }>();
  const damageBySpell = new Map<string, number>();
  // Spells that hit or missed: a missed shot was still a damage cast.
  const attempted = new Set<string>();
  for (const e of events) {
    if (inFight(e) && mine(e) && e.event.endsWith("_MISSED")) attempted.add(e.spell_name ?? "Melee");
    if (!inFight(e) || !ours(e) || !isDamage(e) || !e.dst?.startsWith("Creature-")) continue;
    const amount = e.amount ?? 0;
    if (mine(e)) damage.hunter += amount;
    else damage.pet += amount;
    damage.overkill += Math.max(0, e.overkill ?? 0);
    const t = byTarget.get(e.dst) ?? { name: e.dst_name ?? "", amount: 0 };
    t.amount += amount;
    byTarget.set(e.dst, t);
    const name = mine(e) ? (e.spell_name ?? "Melee") : `Pet: ${e.spell_name ?? "Melee"}`;
    damageBySpell.set(name, (damageBySpell.get(name) ?? 0) + amount);
  }
  const top = [...byTarget].sort((a, b) => b[1].amount - a[1].amount)[0];
  const seen = top && events.find((e) => e.st_guid === top[0] && e.st_level);
  const target = top && { guid: top[0], name: top[1].name, level: seen?.st_level ?? undefined, armor: seen?.st_armor ?? undefined };

  // Casts, failed casts and the time each held the GCD or a cast bar.
  const casts = new Map<string, CastRow>();
  const petCasts = new Map<string, number>();
  const failures = new Map<string, { name: string; reason: string; count: number }>();
  const timeline: TimelineRow[] = [];
  const busy: [number, number][] = [];
  const castStart = new Map<number, number>();
  let manaPct: number | undefined;
  for (const e of events) {
    if (e.st_guid === hunter && e.st_power_type === 0 && e.st_max_power) manaPct = (100 * (e.st_power ?? 0)) / e.st_max_power;
    if (!inFight(e, LEAD_MS) || !e.spell_id) continue;
    if (e.src !== null && pets.has(e.src) && e.event === "SPELL_CAST_SUCCESS") {
      const name = `Pet: ${e.spell_name}`;
      petCasts.set(name, (petCasts.get(name) ?? 0) + 1);
      continue;
    }
    if (!mine(e)) continue;
    if (e.event === "SPELL_CAST_START") castStart.set(e.spell_id, e.ts);
    else if (e.event === "SPELL_CAST_FAILED") {
      const reason = (e.rest ?? "").replace(/^"|"$/g, "");
      const key = `${e.spell_name}|${reason}`;
      const f = failures.get(key) ?? { name: e.spell_name ?? "", reason, count: 0 };
      f.count++;
      failures.set(key, f);
      timeline.push({ t: (e.ts - from) / 1000, what: e.spell_name ?? "", target: "", manaPct, failed: reason });
    } else if (e.event === "SPELL_CAST_SUCCESS") {
      const name = e.spell_name ?? "";
      const spell = game.data.spells[e.spell_id];
      const started = castStart.get(e.spell_id);
      const begin = started !== undefined && e.ts - started < 5000 ? started : e.ts;
      castStart.delete(e.spell_id);
      const end = e.spell_id === 75 ? e.ts : Math.max(e.ts, begin + (spell?.gcdMs ?? 0));
      const c = casts.get(name) ?? { name, casts: 0, damage: 0, dealsDamage: false, busySec: 0 };
      c.casts++;
      c.busySec += (end - begin) / 1000;
      casts.set(name, c);
      if (e.spell_id !== 75) busy.push([begin, end]);
      timeline.push({ t: (e.ts - from) / 1000, what: name, target: e.dst_name ?? "", manaPct, failed: undefined });
    }
  }
  for (const c of casts.values()) {
    c.damage = damageBySpell.get(c.name) ?? 0;
    c.dealsDamage = damageBySpell.has(c.name) || attempted.has(c.name);
  }
  if (damageBySpell.has("Melee")) casts.set("Melee", { name: "Melee", casts: 0, damage: damageBySpell.get("Melee")!, dealsDamage: true, busySec: 0 });

  // Free time: the fight less the union of GCDs and casts.
  busy.sort((a, b) => a[0] - b[0]);
  let busyMs = 0;
  let reach = from;
  for (const [b, e] of busy) {
    const s = Math.max(b, reach, from);
    const t = Math.min(e, to);
    if (t > s) busyMs += t - s;
    reach = Math.max(reach, e);
  }

  // Auto Shot: gaps between shots against the bow speed at each shot.
  // The opening shot goes off before its arrow lands, which is the fight's first hit.
  const shots = events.filter((e) => mine(e) && e.spell_id === 75 && e.event === "SPELL_CAST_SUCCESS" && inFight(e, FLIGHT_MS));
  const gaps = shots.slice(1).map((s, i) => ({ gap: (s.ts - shots[i]!.ts) / 1000, speed: sheetAt(hunter, s.ts)?.rangedSpeed || undefined }));
  const fallback = gaps.length >= 3 ? percentile(gaps.map((g) => g.gap), 0.1) : undefined;
  let delaySec = 0;
  let stoppedSec = 0;
  for (const g of gaps) {
    const speed = g.speed ?? fallback;
    if (!speed) continue;
    const late = Math.max(0, g.gap - speed);
    if (g.gap > STOPPED_GAPS * speed) stoppedSec += late;
    else delaySec += late;
  }
  const autoHits = events.filter((e) => mine(e) && e.spell_id === 75 && inFight(e) && (e.event === "RANGE_DAMAGE" || e.event === "RANGE_MISSED"));
  const speeds = gaps.map((g) => g.speed).filter((s): s is number => s !== undefined);
  const autoShot = {
    shots: shots.length,
    speedSec: speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : fallback,
    speedFromSheet: speeds.length > 0,
    delaySec,
    stoppedSec,
    avgDamage: autoHits.length ? autoHits.reduce((a, e) => a + (e.amount ?? 0), 0) / autoHits.length : 0,
  };

  // Damage over time: each application's length against the target's death and the next refresh.
  const dots = new Map<number, DotRow>();
  const dotSpell = (id: number) => {
    const spell = game.data.spells[id];
    return spell && resolveEffects(spell).some((x) => x.aura === Aura.PeriodicDamage) ? spell : undefined;
  };
  const lastApplied = new Map<string, number>();
  const deaths = new Map(events.filter((e) => e.event === "UNIT_DIED" && e.dst).map((e) => [e.dst!, e.ts]));
  for (const e of events) {
    if (!mine(e) || !e.spell_id || !e.dst) continue;
    const spell = dotSpell(e.spell_id);
    if (!spell || !spell.durationMs) continue;
    const row = dots.get(spell.id) ?? { name: spell.name, applied: 0, ticks: 0, lostToDeathSec: 0, clippedSec: 0, appliedSec: 0 };
    dots.set(spell.id, row);
    if (e.event === "SPELL_PERIODIC_DAMAGE" && inFight(e)) row.ticks++;
    if (!(e.event === "SPELL_AURA_APPLIED" || e.event === "SPELL_AURA_REFRESH") || !inFight(e, LEAD_MS)) continue;
    const key = `${e.dst}|${spell.id}`;
    const prev = lastApplied.get(key);
    if (e.event === "SPELL_AURA_REFRESH" && prev !== undefined) row.clippedSec += Math.max(0, prev + spell.durationMs - e.ts) / 1000;
    lastApplied.set(key, e.ts);
    row.applied++;
    row.appliedSec += spell.durationMs / 1000;
    const died = deaths.get(e.dst);
    // A refresh before the death takes the overlap itself, so only the last application loses time to it.
    const next = events.find((x) => x.ts > e.ts && mine(x) && x.dst === e.dst && x.spell_id === e.spell_id && x.event === "SPELL_AURA_REFRESH");
    if (died !== undefined && died >= e.ts && (!next || next.ts > died)) row.lostToDeathSec += Math.max(0, e.ts + spell.durationMs - died) / 1000;
  }
  for (const [id, row] of dots) if (!row.applied && !row.ticks) dots.delete(id);

  // Uptimes.
  const mark = target ? covered(events, (e) => mine(e) && e.spell_name === "Hunter's Mark", target.guid, from, to) / (to - from) : undefined;
  const aspectNames = new Set(events.filter((e) => e.dst === hunter && e.spell_name?.startsWith("Aspect of the")).map((e) => e.spell_name!));
  const aspects = [...aspectNames]
    .map((name) => ({ name, pct: covered(events, (e) => e.spell_name === name, hunter, from, to) / (to - from) }))
    .filter((a) => a.pct > 0)
    .sort((a, b) => b.pct - a.pct);
  const dazed = events.filter((e) => e.dst === hunter && e.spell_name === "Dazed" && e.event === "SPELL_AURA_APPLIED" && inFight(e)).length;
  let pet: number | undefined;
  const petHits = events.filter((e) => e.src !== null && pets.has(e.src) && inFight(e) && (isDamage(e) || e.event.endsWith("_MISSED"))).map((e) => e.ts);
  if (pets.size) {
    let active = 0;
    for (let i = 1; i < petHits.length; i++) if (petHits[i]! - petHits[i - 1]! <= PET_GAP_MS) active += petHits[i]! - petHits[i - 1]!;
    pet = active / (to - from);
  }

  // Mana and movement, from the hunter's own advanced blocks.
  const own = events.filter((e) => e.st_guid === hunter && inFight(e));
  const mana = own.filter((e) => e.st_power_type === 0 && e.st_max_power).map((e) => (100 * (e.st_power ?? 0)) / e.st_max_power!);
  const placed = own.filter((e) => e.st_x !== null && e.st_y !== null);
  const movement = { movingSec: 0, yards: 0, samples: placed.length };
  for (let i = 1; i < placed.length; i++) {
    const a = placed[i - 1]!;
    const b = placed[i]!;
    const yd = Math.hypot(b.st_x! - a.st_x!, b.st_y! - a.st_y!);
    if (yd <= MOVED_YD || b.ts - a.ts > POSITION_GAP_MS) continue;
    // Positions come only with the hunter's own events, so the time is the distance at run speed.
    movement.movingSec += Math.min((b.ts - a.ts) / 1000, yd / RUN_YD_PER_SEC);
    movement.yards += yd;
  }

  // Button presses from the addon, each matched to a cast of its spell right after it.
  const presses = pressesIn(db, hunter, from - LEAD_MS, to);
  const starts = events.filter((e) => mine(e) && (e.event === "SPELL_CAST_START" || e.event === "SPELL_CAST_SUCCESS"));
  const pressRows = presses.length ? pressCounts(presses, starts) : undefined;

  return {
    fight: { ...fight, hunterName: shortName(fight.hunterName) },
    durationSec,
    target,
    damage,
    casts: [...casts.values()].sort((a, b) => b.damage - a.damage || b.casts - a.casts),
    petAbilities: [...damageBySpell]
      .filter(([name]) => name.startsWith("Pet: "))
      .concat([...petCasts.keys()].filter((name) => !damageBySpell.has(name)).map((name) => [name, 0]))
      .map(([name, damage]) => ({ name, casts: petCasts.get(name) ?? 0, damage }))
      .sort((a, b) => b.damage - a.damage),
    failures: [...failures.values()].sort((a, b) => b.count - a.count),
    timeline,
    autoShot,
    freeSec: Math.max(0, (to - from - busyMs) / 1000),
    dots: [...dots.values()],
    uptime: { mark, aspects, pet, dazed },
    mana: mana.length ? { startPct: mana[0]!, minPct: Math.min(...mana), endPct: mana[mana.length - 1]! } : undefined,
    movement,
    presses: pressRows,
    level: sheetAt(hunter, from)?.level,
  };
}

// Presses per action, and how many of them started or cast their spell.
export function pressCounts(presses: Press[], casts: { ts: number; spell_id: number | null }[]): { name: string; presses: number; casts: number }[] {
  const rows = new Map<string, { name: string; presses: number; casts: number }>();
  for (const p of presses) {
    const r = rows.get(p.name) ?? { name: p.name, presses: 0, casts: 0 };
    r.presses++;
    if (p.spellId && casts.some((c) => c.spell_id === p.spellId && c.ts >= p.ts && c.ts - p.ts <= PRESS_MS)) r.casts++;
    rows.set(p.name, r);
  }
  return [...rows.values()].sort((a, b) => b.presses - a.presses);
}
