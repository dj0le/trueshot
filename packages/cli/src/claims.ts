// Claimed vs reality (task 42): what the client data, the tooltips and our model say against what the
// ingested combat logs show. Each claim names its source and measures itself on the store; a verdict
// needs enough samples, and a claimed value inside the observed 95% interval (or a tolerance for
// integer rounding) fits.
//
// The log cannot give everything. For players the advanced block's last field is item level, not
// character level, and its attack power does not move Serpent Sting ticks the way ranged attack
// power does, so claims that need the hunter's level or ranged attack power wait for COMBATANT_INFO
// or the addon's character sheet (task 44). Creatures and pets log their real level.
import type { Database } from "bun:sqlite";
import type { GameData } from "@hunter-sim/data";
import { attackTable, Aura, resolveEffects } from "@hunter-sim/engine";

export type Verdict = "fits" | "differs" | "too few" | "observed";

export type ClaimRow = {
  claim: string;
  subject: string;
  source: string;
  claimed: string;
  observed: string;
  n: number;
  verdict: Verdict;
};

type Row = {
  ts: number;
  event: string;
  src: string | null;
  src_name: string | null;
  src_kind: string | null;
  dst: string | null;
  dst_name: string | null;
  spell_id: number | null;
  spell_name: string | null;
  school: number | null;
  st_guid: string | null;
  st_armor: number | null;
  st_level: number | null;
  amount: number | null;
  unmitigated: number | null;
  overkill: number | null;
  dmg_school: number | null;
  resisted: number | null;
  blocked: number | null;
  absorbed: number | null;
  crit: number | null;
  glancing: number | null;
  miss_type: string | null;
};

// Fewer samples than this give no verdict.
const MIN_N = 10;
const PHYSICAL = 1;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
// Half-width of the 95% interval of the mean.
const ci95 = (xs: number[]) => {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  return (1.96 * Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))) / Math.sqrt(xs.length);
};
// The 95% interval of a proportion (Wilson), in percent.
const wilson = (k: number, n: number): [number, number] => {
  if (n === 0) return [0, 100];
  const z = 1.96;
  const p = k / n;
  const c = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return [100 * Math.max(0, c - h), 100 * Math.min(1, c + h)];
};
const f = (x: number, digits = 2) => x.toFixed(digits);

function verdictOfMean(claimed: number, xs: number[], tolerance = 0): Verdict {
  if (xs.length < MIN_N) return "too few";
  return Math.abs(mean(xs) - claimed) <= Math.max(ci95(xs), tolerance) ? "fits" : "differs";
}

function verdictOfRate(claimedPct: number, k: number, n: number): Verdict {
  if (n < MIN_N) return "too few";
  const [lo, hi] = wilson(k, n);
  return claimedPct >= lo && claimedPct <= hi ? "fits" : "differs";
}

const rateText = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return `${f((100 * k) / Math.max(1, n), 1)}% (${f(lo, 1)}-${f(hi, 1)})`;
};

// A clean hit: nothing resisted, blocked or absorbed, and no overkill cutting the amount.
const clean = (r: Row) => !r.resisted && !r.blocked && !r.absorbed && (r.overkill ?? -1) <= 0 && (r.unmitigated ?? 0) > 0;

export function loadRows(db: Database, hunter?: string): Row[] {
  const rows = db
    .query<Row, []>(
      `SELECT e.ts, e.event, e.src, e.src_name, u.kind AS src_kind, e.dst, e.dst_name, e.spell_id, e.spell_name, e.school,
        e.st_guid, e.st_armor, e.st_level, e.amount, e.unmitigated, e.overkill, e.dmg_school, e.resisted, e.blocked,
        e.absorbed, e.crit, e.glancing, e.miss_type
       FROM events e LEFT JOIN units u ON u.guid = e.src ORDER BY e.ts, e.id`,
    )
    .all();
  if (!hunter) return rows;
  const owners = new Map(db.query<{ guid: string; owner: string; name: string; kind: string }, []>("SELECT * FROM units").all().map((u) => [u.guid, u]));
  const mine = (guid: string | null) => {
    const u = guid ? owners.get(guid) : undefined;
    if (!u) return true;
    const h = u.kind === "hunter" ? u : owners.get(u.owner);
    return h?.name === hunter || h?.guid === hunter;
  };
  return rows.filter((r) => mine(r.src));
}

// Creatures' and pets' levels as logged up to each row (players log item level, so they are left
// out). Pets level with the hunter, so a level is only good for the time it was seen.
type Leveled = Row & { srcLevel: number | undefined; dstLevel: number | undefined };
function withLevels(rows: Row[]): Leveled[] {
  const at = new Map<string, number>();
  return rows.map((r) => {
    if (r.st_guid && !r.st_guid.startsWith("Player-") && r.st_level) at.set(r.st_guid, r.st_level);
    return { ...r, srcLevel: r.src ? at.get(r.src) : undefined, dstLevel: r.dst ? at.get(r.dst) : undefined };
  });
}

// Periodic damage from hunters' spells: the client's tick against the logged ticks, and whether
// ticks crit (our model never crits a tick).
function periodic(game: GameData, rows: Row[]): ClaimRow[] {
  const out: ClaimRow[] = [];
  const bySpell = new Map<number, Row[]>();
  for (const r of rows) {
    if (r.event === "SPELL_PERIODIC_DAMAGE" && r.src_kind === "hunter" && r.spell_id) {
      bySpell.set(r.spell_id, [...(bySpell.get(r.spell_id) ?? []), r]);
    }
  }
  for (const [id, ticks] of bySpell) {
    const spell = game.data.spells[id];
    const effect = spell && resolveEffects(spell).find((e) => e.aura === Aura.PeriodicDamage);
    const name = `${ticks[0]!.spell_name} (${id})`;
    const plain = ticks.filter((t) => !t.crit && clean(t)).map((t) => t.amount!);
    if (effect && plain.length) {
      const scales = effect.apCoefficient > 0;
      out.push({
        claim: "periodic tick",
        subject: name,
        source: "client data (our model)",
        claimed: scales ? `${f(effect.value, 0)} + ${effect.apCoefficient} x RAP` : `${f(effect.value, 0)}, no attack power`,
        observed: `${f(mean(plain), 1)} ± ${f(ci95(plain), 1)} (${Math.min(...plain)}-${Math.max(...plain)})`,
        n: plain.length,
        // A tick that scales needs the hunter's ranged attack power, which the log lacks.
        verdict: scales ? "observed" : verdictOfMean(effect.value, plain, 0.5),
      });
    }
    const crits = ticks.filter((t) => t.crit).length;
    out.push({
      claim: "ticks crit",
      subject: name,
      source: "our model: ticks never crit",
      claimed: "0%",
      observed: rateText(crits, ticks.length),
      n: ticks.length,
      verdict: verdictOfRate(0, crits, ticks.length),
    });
  }
  return out;
}

// Crit damage where armor plays no part (non-physical schools): the log's amount over its amount
// before crit.
function critMultiplier(game: GameData, rows: Row[]): ClaimRow[] {
  const claimed = 1 + game.overrides.formula.critDamageBonusPct.value / 100;
  const bySpell = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.crit || !r.src_kind || r.event.endsWith("_LANDED") || r.dmg_school === PHYSICAL || !clean(r)) continue;
    const key = r.spell_name ?? "Melee";
    bySpell.set(key, [...(bySpell.get(key) ?? []), r.amount! / r.unmitigated!]);
  }
  return [...bySpell].map(([name, ratios]) => ({
    claim: "crit multiplier",
    subject: name,
    source: "overrides.toml formula.critDamageBonusPct (Classic)",
    claimed: f(claimed),
    observed: `${f(mean(ratios), 3)} ± ${f(ci95(ratios), 3)}`,
    n: ratios.length,
    verdict: verdictOfMean(claimed, ratios, 0.02),
  }));
}

// Armor on pet swings: SWING_DAMAGE_LANDED carries the target's live armor (debuffs included), the
// pet's own swing line its level. Hunters' shots show the armor constant they imply, since the log
// has no hunter level.
function armor(game: GameData, rows: Leveled[]): ClaimRow[] {
  const fo = game.overrides.formula;
  const k = (level: number) => fo.armorConstantBase.value + fo.armorConstantPerLevel.value * level;
  const pet: number[] = [];
  const petClaimed: number[] = [];
  const implied: number[] = [];
  for (const r of rows) {
    if (r.crit || r.glancing || !clean(r) || r.dmg_school !== PHYSICAL || !r.st_armor || r.st_guid !== r.dst) continue;
    const reduction = 1 - r.amount! / r.unmitigated!;
    if (r.event === "SWING_DAMAGE_LANDED" && r.src_kind === "pet") {
      const level = r.srcLevel;
      if (!level) continue;
      pet.push(reduction);
      petClaimed.push(r.st_armor / (r.st_armor + k(level)));
    } else if (r.src_kind === "hunter" && (r.event === "RANGE_DAMAGE" || r.event === "SPELL_DAMAGE") && reduction > 0.01) {
      // reduction = armor / (armor + K)  =>  K = armor / reduction - armor
      implied.push(r.st_armor / reduction - r.st_armor);
    }
  }
  const out: ClaimRow[] = [];
  if (pet.length) {
    const diffs = pet.map((x, i) => x - petClaimed[i]!);
    out.push({
      claim: "armor reduction",
      subject: "pet melee",
      source: "overrides.toml formula.armorConstant* (Classic: armor / (armor + 400 + 85 x level))",
      claimed: `${f(100 * mean(petClaimed), 1)}%`,
      observed: `${f(100 * mean(pet), 1)}% (gap ${f(100 * mean(diffs), 1)} ± ${f(100 * ci95(diffs), 1)})`,
      n: pet.length,
      // Integer rounding moves a single hit's reduction by up to 1 / hit; half a point covers it on average.
      verdict: verdictOfMean(0, diffs, 0.005),
    });
  }
  if (implied.length) {
    out.push({
      claim: "armor constant",
      subject: "hunter shots",
      source: "Classic: 400 + 85 x hunter level",
      claimed: `${fo.armorConstantBase.value} + ${fo.armorConstantPerLevel.value} x level`,
      observed: `K ${f(median(implied), 0)} median (level ${f((median(implied) - fo.armorConstantBase.value) / fo.armorConstantPerLevel.value, 1)} by the formula)`,
      n: implied.length,
      verdict: "observed",
    });
  }
  return out;
}

// Pet swing timer: gaps between one pet's swings, under 4 sec so pauses drop out.
function petSwings(game: GameData, rows: Row[]): ClaimRow[] {
  const claimed = game.overrides.pet.attackSpeedSec.value;
  const last = new Map<string, number>();
  const gaps = new Map<string, { name: string; gaps: number[] }>();
  for (const r of rows) {
    if (r.src_kind !== "pet" || !(r.event === "SWING_DAMAGE" || r.event === "SWING_MISSED") || !r.src) continue;
    const prev = last.get(r.src);
    last.set(r.src, r.ts);
    if (prev === undefined || r.ts - prev > 4000 || r.ts === prev) continue;
    const g = gaps.get(r.src) ?? { name: r.src_name ?? r.src, gaps: [] };
    g.gaps.push((r.ts - prev) / 1000);
    gaps.set(r.src, g);
  }
  return [...gaps.values()].map((g) => ({
    claim: "pet swing speed",
    subject: g.name,
    source: "overrides.toml pet.attackSpeedSec (fast pets assumed normalized to the same DPS)",
    claimed: `${claimed} sec`,
    observed: `${f(median(g.gaps))} sec median`,
    n: g.gaps.length,
    verdict: g.gaps.length < MIN_N ? "too few" : Math.abs(median(g.gaps) - claimed) <= 0.1 ? "fits" : "differs",
  }));
}

// Auto Shot as the log shows it: the time between shots, and the wind-up from its cast start to the
// shot. Its claimed speed needs the bow, from COMBATANT_INFO or the addon.
function autoShot(rows: Row[]): ClaimRow[] {
  const byHunter = new Map<string, { name: string; start?: number | undefined; last?: number; gaps: number[]; windups: number[] }>();
  for (const r of rows) {
    if (r.spell_id !== 75 || r.src_kind !== "hunter" || !r.src) continue;
    const h = byHunter.get(r.src) ?? { name: r.src_name ?? r.src, gaps: [], windups: [] };
    byHunter.set(r.src, h);
    if (r.event === "SPELL_CAST_START") h.start = r.ts;
    else if (r.event === "SPELL_CAST_SUCCESS") {
      if (h.start !== undefined && r.ts - h.start < 1000) h.windups.push((r.ts - h.start) / 1000);
      if (h.last !== undefined && r.ts - h.last < 5000) h.gaps.push((r.ts - h.last) / 1000);
      h.last = r.ts;
      h.start = undefined;
    }
  }
  return [...byHunter.values()].flatMap((h) => [
    ...(h.gaps.length
      ? [{ claim: "Auto Shot interval", subject: h.name, source: "bow speed (needs gear)", claimed: "", observed: `${f(median(h.gaps))} sec median`, n: h.gaps.length, verdict: "observed" as const }]
      : []),
    ...(h.windups.length
      ? [{ claim: "Auto Shot wind-up", subject: h.name, source: "cast start to shot", claimed: "", observed: `${f(median(h.windups))} sec median`, n: h.windups.length, verdict: "observed" as const }]
      : []),
  ]);
}

// Pet misses and dodges by level gap, against the attack table at no hit from gear (pets inherit
// the hunter's hit, which the log does not show, so a miss rate under the claim is expected).
function petAttackTable(game: GameData, rows: Leveled[]): ClaimRow[] {
  const byGap = new Map<number, { swings: number; miss: number; dodge: number; petLevel: number; targetLevel: number }>();
  for (const r of rows) {
    if (r.src_kind !== "pet" || !(r.event === "SWING_DAMAGE" || r.event === "SWING_MISSED") || !r.dst?.startsWith("Creature-")) continue;
    const pet = r.srcLevel;
    const target = r.dstLevel;
    if (!pet || !target) continue;
    const gap = target - pet;
    const g = byGap.get(gap) ?? { swings: 0, miss: 0, dodge: 0, petLevel: pet, targetLevel: target };
    g.swings++;
    if (r.miss_type === "MISS") g.miss++;
    if (r.miss_type === "DODGE") g.dodge++;
    byGap.set(gap, g);
  }
  return [...byGap]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([gap, g]) => {
      const t = attackTable(game.overrides.formula, g.petLevel, g.targetLevel);
      const subject = `pet vs ${gap >= 0 ? "+" : ""}${gap} levels`;
      return [
        { claim: "pet miss", subject, source: "levels.ts attackTable, no hit", claimed: `${f(t.missPct, 1)}%`, observed: rateText(g.miss, g.swings), n: g.swings, verdict: verdictOfRate(t.missPct, g.miss, g.swings) },
        { claim: "pet dodge", subject, source: "levels.ts attackTable", claimed: `${f(t.dodgePct, 1)}%`, observed: rateText(g.dodge, g.swings), n: g.swings, verdict: verdictOfRate(t.dodgePct, g.dodge, g.swings) },
      ];
    });
}

export function claims(game: GameData, db: Database, hunter?: string): ClaimRow[] {
  const rows = withLevels(loadRows(db, hunter));
  return [
    ...periodic(game, rows),
    ...critMultiplier(game, rows),
    ...armor(game, rows),
    ...petSwings(game, rows),
    ...petAttackTable(game, rows),
    ...autoShot(rows),
  ];
}
