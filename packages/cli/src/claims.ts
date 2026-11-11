// Claimed vs reality (task 42): what the client data, the tooltips and our model say against what the
// ingested combat logs show. Each claim names its source and measures itself on the store; a verdict
// needs enough samples, and a claimed value inside the observed 95% interval (or a tolerance for
// integer rounding) fits.
//
// The log cannot give everything. For players the advanced block's last field is item level, not
// character level, and its attack power does not move Serpent Sting ticks the way ranged attack
// power does, so claims that need the hunter's level, ranged attack power, crit or bow speed read
// the Trueshot addon's sheets, stored next to the events. Creatures and pets log their
// real level.
import type { Database } from "bun:sqlite";
import { excludedUnits, type GameData, type Patch, patchOfLine, type Sheet, sheetsAt } from "@trueshot/data";
import { attackTable, Aura, DefenseType, resolveEffects } from "@trueshot/engine";

export type Verdict = "fits" | "differs" | "too few" | "observed";

// The number behind an observation, for comparing patches: a mean with its 95% half-width, or a
// rate as k of n.
export type Stat = { mean: number; ci: number } | { k: number; n: number };

export type ClaimRow = {
  claim: string;
  subject: string;
  source: string;
  claimed: string;
  observed: string;
  n: number;
  verdict: Verdict;
  stat?: Stat;
};

type Row = {
  file: string;
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
  // Exact ends: none seen can still be 0%, all seen can still be 100% (rounding left 1e-15 there).
  return [k === 0 ? 0 : 100 * Math.max(0, c - h), k === n ? 100 : 100 * Math.min(1, c + h)];
};
const f = (x: number, digits = 2) => x.toFixed(digits);

// y = a + b x by least squares, with b's 95% half-width.
function fit(xs: number[], ys: number[]): { a: number; b: number; bCi: number } | undefined {
  const mx = mean(xs);
  const my = mean(ys);
  const sxx = xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
  if (xs.length < 3 || sxx === 0) return undefined;
  const b = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i]! - my), 0) / sxx;
  const a = my - b * mx;
  const residual = ys.reduce((acc, y, i) => acc + (y - a - b * xs[i]!) ** 2, 0) / (xs.length - 2);
  return { a, b, bCi: 1.96 * Math.sqrt(residual / sxx) };
}

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

export function loadRows(db: Database, hunter?: string, patches?: Patch[], patch?: Patch): Row[] {
  const all = db
    .query<Row, []>(
      `SELECT e.file, e.ts, e.event, e.src, e.src_name, u.kind AS src_kind, e.dst, e.dst_name, e.spell_id, e.spell_name, e.school,
        e.st_guid, e.st_armor, e.st_level, e.amount, e.unmitigated, e.overkill, e.dmg_school, e.resisted, e.blocked,
        e.absorbed, e.crit, e.glancing, e.miss_type
       FROM events e LEFT JOIN units u ON u.guid = e.src ORDER BY e.ts, e.id`,
    )
    .all();
  const patchOf = patches && patch ? patchOfLine(db, patches) : undefined;
  const excluded = excludedUnits();
  const rows = all.filter((r) => !(r.src && excluded.has(r.src)) && (!patchOf || patchOf(r.file, r.ts).id === patch!.id));
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

// Creatures' levels as logged up to each row. Players log item level, and pets log their owner's
// item level (297 of 300 sampled pet lines matched, launch logs 2026-11-05), so both are left out;
// a pet's level comes from its owner's addon sheet at the time, else it is unknown.
type Leveled = Row & { srcLevel: number | undefined; dstLevel: number | undefined };
type SheetAt = (guid: string, ts: number) => Sheet | undefined;
function withLevels(rows: Row[], petSheet: PetSheetAt): Leveled[] {
  const petLevel = (guid: string, ts: number) => petSheet(guid, ts)?.pet?.level || undefined;
  const at = new Map<string, number>();
  const level = (guid: string | null, ts: number) =>
    !guid ? undefined : guid.startsWith("Pet-") ? petLevel(guid, ts) : at.get(guid);
  return rows.map((r) => {
    if (r.st_guid && !r.st_guid.startsWith("Player-") && !r.st_guid.startsWith("Pet-") && r.st_level) at.set(r.st_guid, r.st_level);
    return { ...r, srcLevel: level(r.src, r.ts), dstLevel: level(r.dst, r.ts) };
  });
}

// A pet as "name (owner)". Its GUID changes with each summon and zone, but the last 8 characters
// (its pet number) stay, through renames too, so claims group GUIDs by owner and pet number and name
// the row with every name it had ("The Rake / waffles (Flipp)").
type PetName = (guid: string, name: string | null) => string;
function petNames(db: Database): PetName {
  const units = db.query<{ guid: string; name: string; owner: string }, []>("SELECT guid, name, owner FROM units").all();
  const byGuid = new Map(units.map((u) => [u.guid, u]));
  const petKey = (guid: string, owner: string) => `${owner}|${guid.slice(-8)}`;
  const names = new Map<string, Set<string>>();
  for (const u of units) {
    if (!u.guid.startsWith("Pet-") || !u.owner) continue;
    const k = petKey(u.guid, u.owner);
    names.set(k, (names.get(k) ?? new Set()).add(u.name));
  }
  return (guid, name) => {
    const u = byGuid.get(guid);
    const owner = byGuid.get(u?.owner ?? "")?.name;
    const all = u?.owner ? names.get(petKey(guid, u.owner)) : undefined;
    const label = all ? [...all].sort().join(" / ") : (name ?? guid);
    return `${label}${owner ? ` (${owner})` : ""}`;
  };
}

// A pet's owner's sheet at a time: its pet block gives the pet's level and shown swing speed.
type PetSheetAt = (guid: string, ts: number) => Sheet | undefined;
function petSheets(db: Database, sheetAt: SheetAt): PetSheetAt {
  const owner = new Map(db.query<{ guid: string; owner: string }, []>("SELECT guid, owner FROM units WHERE owner != ''").all().map((u) => [u.guid, u.owner]));
  return (guid, ts) => {
    const o = owner.get(guid);
    return o ? sheetAt(o, ts) : undefined;
  };
}

// Periodic damage from hunters' spells: the client's tick against the logged ticks, and whether
// ticks crit (at ranged crit, formula.rangedTicksCrit). With sheets, the tick is fitted against the ranged
// attack power at application (ticks snapshot it) to measure the attack power share a tick.
function periodic(game: GameData, rows: Leveled[], sheetAt: SheetAt): ClaimRow[] {
  const out: ClaimRow[] = [];
  const bySpell = new Map<number, { ticks: Leveled[]; raps: (number | undefined)[] }>();
  const appliedAt = new Map<string, number>();
  for (const r of rows) {
    if (r.src_kind !== "hunter" || !r.spell_id) continue;
    const key = `${r.src}|${r.dst}|${r.spell_id}`;
    if (r.event === "SPELL_AURA_APPLIED" || r.event === "SPELL_AURA_REFRESH") appliedAt.set(key, r.ts);
    if (r.event !== "SPELL_PERIODIC_DAMAGE") continue;
    const s = bySpell.get(r.spell_id) ?? { ticks: [], raps: [] };
    const applied = appliedAt.get(key);
    s.ticks.push(r);
    s.raps.push(applied !== undefined ? sheetAt(r.src!, applied)?.rap : undefined);
    bySpell.set(r.spell_id, s);
  }
  for (const [id, { ticks, raps }] of bySpell) {
    const spell = game.data.spells[id];
    const effect = spell && resolveEffects(spell).find((e) => e.aura === Aura.PeriodicDamage);
    const name = `${ticks[0]!.spell_name} (${id})`;
    const plain = ticks.flatMap((t, i) => (!t.crit && clean(t) ? [{ amount: t.amount!, rap: raps[i] }] : []));
    if (effect && plain.length) {
      const scales = effect.apCoefficient > 0;
      const amounts = plain.map((p) => p.amount);
      out.push({
        claim: "periodic tick",
        subject: name,
        source: "client data (our model)",
        claimed: scales ? `${f(effect.value, 0)} + ${effect.apCoefficient} x RAP` : `${f(effect.value, 0)}, no attack power`,
        observed: `${f(mean(amounts), 1)} ± ${f(ci95(amounts), 1)} (${Math.min(...amounts)}-${Math.max(...amounts)})`,
        n: amounts.length,
        stat: { mean: mean(amounts), ci: ci95(amounts) },
        // A tick that scales needs the hunter's ranged attack power: the fit below.
        verdict: scales ? "observed" : verdictOfMean(effect.value, amounts, 0.5),
      });
      const known = plain.filter((p) => p.rap !== undefined);
      const line = fit(known.map((p) => p.rap!), known.map((p) => p.amount));
      if (line) {
        out.push({
          claim: "tick per RAP",
          subject: name,
          source: "client data (our model); talents that raise stings scale both terms",
          claimed: `${effect.apCoefficient} a tick`,
          observed: `${f(line.b, 4)} ± ${f(line.bCi, 4)} (tick ${f(line.a, 1)} at no RAP)`,
          n: known.length,
          stat: { mean: line.b, ci: line.bCi },
          verdict: known.length < MIN_N ? "too few" : Math.abs(line.b - effect.apCoefficient) <= line.bCi ? "fits" : "differs",
        });
      }
    }
    // The model crits ranged and magic ticks at the sheet's ranged crit less suppression
    // (formula.rangedTicksCrit, magicTicksCrit).
    const crits = ticks.filter((t) => t.crit).length;
    const fo = game.overrides.formula;
    const ticksCrit =
      (fo.rangedTicksCrit.value > 0 && spell?.defenseType === DefenseType.Ranged) ||
      (fo.magicTicksCrit.value > 0 && spell?.defenseType === DefenseType.Magic);
    let expected = 0;
    if (ticksCrit) {
      for (const t of ticks) {
        const sheet = sheetAt(t.src!, t.ts);
        if (sheet && t.dstLevel) expected += Math.max(0, sheet.rangedCritPct - attackTable(game.overrides.formula, sheet.level, t.dstLevel).critSuppressionPct);
      }
    }
    const claimedPct = ticksCrit ? expected / ticks.length : 0;
    out.push({
      claim: "ticks crit",
      subject: name,
      source: ticksCrit ? "sheet ranged crit less levels.ts crit suppression (formula.rangedTicksCrit, magicTicksCrit)" : "our model: ticks never crit",
      claimed: `${f(claimedPct, 1)}%`,
      observed: rateText(crits, ticks.length),
      n: ticks.length,
      stat: { k: crits, n: ticks.length },
      verdict: verdictOfRate(claimedPct, crits, ticks.length),
    });
  }
  return out;
}

// Crit damage where armor plays no part (non-physical schools): the log's amount over its amount
// before crit.
function critMultiplier(game: GameData, rows: Row[]): ClaimRow[] {
  const fo = game.overrides.formula;
  const bySpell = new Map<string, { magic: boolean; ratios: number[] }>();
  for (const r of rows) {
    if (!r.crit || !r.src_kind || r.event.endsWith("_LANDED") || r.dmg_school === PHYSICAL || !clean(r)) continue;
    const key = r.spell_name ?? "Melee";
    const magic = r.spell_id != null && game.data.spells[String(r.spell_id)]?.defenseType === DefenseType.Magic;
    const s = bySpell.get(key) ?? { magic, ratios: [] };
    s.ratios.push(r.amount! / r.unmitigated!);
    bySpell.set(key, s);
  }
  return [...bySpell].map(([name, { magic, ratios }]) => {
    const claimed = 1 + (magic ? fo.spellCritDamageBonusPct : fo.critDamageBonusPct).value / 100;
    return {
      claim: "crit multiplier",
      subject: name,
      source: magic ? "overrides.toml formula.spellCritDamageBonusPct (Classic spell crit)" : "overrides.toml formula.critDamageBonusPct (Classic)",
      claimed: f(claimed),
      observed: `${f(mean(ratios), 3)} ± ${f(ci95(ratios), 3)}`,
      n: ratios.length,
      stat: { mean: mean(ratios), ci: ci95(ratios) },
      verdict: verdictOfMean(claimed, ratios, 0.02),
    };
  });
}

// Armor on pet swings: SWING_DAMAGE_LANDED carries the target's live armor (debuffs included), the
// pet's own swing line its level. Hunters' shots show the armor constant they imply, since the log
// has no hunter level.
function armor(game: GameData, rows: Leveled[], sheetAt: SheetAt): ClaimRow[] {
  const fo = game.overrides.formula;
  const k = (level: number) => fo.armorConstantBase.value + fo.armorConstantPerLevel.value * level;
  const pet: number[] = [];
  const petClaimed: number[] = [];
  const implied: number[] = [];
  const shots: number[] = [];
  const shotsClaimed: number[] = [];
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
      const level = sheetAt(r.src!, r.ts)?.level;
      if (level) {
        shots.push(reduction);
        shotsClaimed.push(r.st_armor / (r.st_armor + k(level)));
      }
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
      stat: { mean: mean(diffs), ci: ci95(diffs) },
      // Integer rounding moves a single hit's reduction by up to 1 / hit; half a point covers it on average.
      verdict: verdictOfMean(0, diffs, 0.005),
    });
  }
  if (shots.length) {
    const diffs = shots.map((x, i) => x - shotsClaimed[i]!);
    out.push({
      claim: "armor reduction",
      subject: "hunter shots",
      source: "overrides.toml formula.armorConstant* (Classic: armor / (armor + 400 + 85 x level))",
      claimed: `${f(100 * mean(shotsClaimed), 1)}%`,
      observed: `${f(100 * mean(shots), 1)}% (gap ${f(100 * mean(diffs), 1)} ± ${f(100 * ci95(diffs), 1)})`,
      n: shots.length,
      stat: { mean: mean(diffs), ci: ci95(diffs) },
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
// With the owner's sheet the claim is the speed the game shows for the pet (UnitAttackSpeed), else
// the override. The mean is the verdict: a fast pet swings in pairs (short gap, long gap), so its
// median lands on the long gap and says nothing about damage.
function petSwings(game: GameData, rows: Row[], petSheet: PetSheetAt, petName: PetName): ClaimRow[] {
  const fallback = game.overrides.pet.attackSpeedSec.value;
  const last = new Map<string, number>();
  const gaps = new Map<string, { name: string; gaps: number[]; shown: number[] }>();
  for (const r of rows) {
    if (r.src_kind !== "pet" || !(r.event === "SWING_DAMAGE" || r.event === "SWING_MISSED") || !r.src) continue;
    const prev = last.get(r.src);
    last.set(r.src, r.ts);
    if (prev === undefined || r.ts - prev > 4000 || r.ts === prev) continue;
    const name = petName(r.src, r.src_name);
    const g = gaps.get(name) ?? { name, gaps: [], shown: [] };
    g.gaps.push((r.ts - prev) / 1000);
    const speed = petSheet(r.src, r.ts)?.pet?.speed;
    if (speed) g.shown.push(speed);
    gaps.set(name, g);
  }
  return [...gaps.values()].map((g) => {
    const claimed = g.shown.length ? median(g.shown) : fallback;
    const mean = g.gaps.reduce((a, b) => a + b, 0) / g.gaps.length;
    return {
      claim: "pet swing speed",
      subject: g.name,
      source: g.shown.length ? "pet speed on the owner's sheet" : "overrides.toml pet.attackSpeedSec (fast pets assumed normalized to the same DPS)",
      claimed: `${f(claimed)} sec`,
      observed: `${f(mean)} sec mean, ${f(median(g.gaps))} median`,
      n: g.gaps.length,
      stat: { mean, ci: ci95(g.gaps) },
      verdict: g.gaps.length < MIN_N ? "too few" : Math.abs(mean - claimed) <= 0.1 ? "fits" : "differs",
    };
  });
}

// Pet white swing crits and glancing blows per pet: crit against pet.whiteCritPct (task 54), glancing
// against levels.ts's attack table.
function petCrit(game: GameData, rows: Leveled[], petSheet: PetSheetAt, petName: PetName): ClaimRow[] {
  const byPet = new Map<string, { name: string; hits: number; crits: number; glancing: number; expected: number; sheets: number }>();
  for (const r of rows) {
    if (r.src_kind !== "pet" || r.event !== "SWING_DAMAGE" || !r.src || !r.dst?.startsWith("Creature-")) continue;
    // Pets with no owner sheet are pooled: one by one their samples are too small to say anything.
    const sheet = petSheet(r.src, r.ts);
    const name = sheet ? petName(r.src, r.src_name) : "pets of hunters with no sheet";
    const p = byPet.get(name) ?? { name, hits: 0, crits: 0, glancing: 0, expected: 0, sheets: 0 };
    byPet.set(name, p);
    p.hits++;
    if (r.crit) p.crits++;
    if (r.glancing) p.glancing++;
    if (r.srcLevel && r.dstLevel) {
      p.expected += attackTable(game.overrides.formula, r.srcLevel, r.dstLevel, game.overrides.pet.glancingPerSkillPct.value).glancingPct;
      p.sheets++;
    }
  }
  const critPct = game.overrides.pet.whiteCritPct.value;
  return [...byPet.values()].flatMap((p): ClaimRow[] => {
    const glancePct = p.sheets ? p.expected / p.sheets : undefined;
    return [
      {
        claim: "pet crit",
        subject: p.name,
        source: "overrides.toml pet.whiteCritPct, no pet crit auras counted",
        claimed: `${f(critPct, 2)}%`,
        observed: rateText(p.crits, p.hits),
        n: p.hits,
        stat: { k: p.crits, n: p.hits },
        verdict: verdictOfRate(critPct, p.crits, p.hits),
      },
      {
        claim: "pet glancing",
        subject: p.name,
        source: glancePct !== undefined ? "levels.ts attackTable at the pet's level" : "no pet level (needs the owner's sheet)",
        claimed: glancePct !== undefined ? `${f(glancePct, 1)}%` : "",
        observed: rateText(p.glancing, p.hits),
        n: p.hits,
        stat: { k: p.glancing, n: p.hits },
        verdict: glancePct !== undefined ? verdictOfRate(glancePct, p.glancing, p.hits) : "observed",
      },
    ];
  });
}

// Pet special attacks (Claw, Bite, Lightning Breath) per pet and ability: the model crits them at the
// owner's sheet crit less the target's suppression, unlike white swings (task 54). Pet crit auras are
// not counted, so a pet with Ferocity reads high. Pets with no owner sheet are pooled per ability.
function petSpecials(game: GameData, rows: Leveled[], petSheet: PetSheetAt, petName: PetName): ClaimRow[] {
  const by = new Map<string, { subject: string; hits: number; crits: number; expected: number; known: number }>();
  for (const r of rows) {
    if (r.src_kind !== "pet" || r.event !== "SPELL_DAMAGE" || !r.src || !r.dst?.startsWith("Creature-")) continue;
    const sheet = petSheet(r.src, r.ts);
    const subject = `${r.spell_name} by ${sheet ? petName(r.src, r.src_name) : "pets of hunters with no sheet"}`;
    const g = by.get(subject) ?? { subject, hits: 0, crits: 0, expected: 0, known: 0 };
    by.set(subject, g);
    g.hits++;
    if (r.crit) g.crits++;
    if (sheet && r.srcLevel && r.dstLevel) {
      g.expected += Math.max(0, sheet.rangedCritPct - attackTable(game.overrides.formula, r.srcLevel, r.dstLevel).critSuppressionPct);
      g.known++;
    }
  }
  return [...by.values()].map((g) => {
    const claimedPct = g.known ? g.expected / g.known : undefined;
    return {
      claim: "pet special crit",
      subject: g.subject,
      source: claimedPct !== undefined ? "the owner's sheet crit less suppression (pet.ts critPct)" : "no owner sheet",
      claimed: claimedPct !== undefined ? `${f(claimedPct, 1)}%` : "",
      observed: rateText(g.crits, g.hits),
      n: g.hits,
      stat: { k: g.crits, n: g.hits },
      verdict: claimedPct !== undefined ? verdictOfRate(claimedPct, g.crits, g.hits) : "observed",
    };
  });
}

// Auto Shot: the time between shots against the bow speed on the sheet (haste included), its
// wind-up from cast start to shot, and its crit rate against the sheet's ranged crit less the
// target's suppression. Without sheets only the timings show.
function autoShot(game: GameData, rows: Leveled[], sheetAt: SheetAt): ClaimRow[] {
  type Shots = { name: string; start?: number | undefined; last?: number; gaps: number[]; overSpeed: number[]; windups: number[]; hits: number; crits: number; expected: number };
  const byHunter = new Map<string, Shots>();
  for (const r of rows) {
    if (r.spell_id !== 75 || r.src_kind !== "hunter" || !r.src) continue;
    const h = byHunter.get(r.src) ?? { name: r.src_name ?? r.src, gaps: [], overSpeed: [], windups: [], hits: 0, crits: 0, expected: 0 };
    byHunter.set(r.src, h);
    const sheet = sheetAt(r.src, r.ts);
    if (r.event === "SPELL_CAST_START") h.start = r.ts;
    else if (r.event === "SPELL_CAST_SUCCESS") {
      if (h.start !== undefined && r.ts - h.start < 1000) h.windups.push((r.ts - h.start) / 1000);
      if (h.last !== undefined && r.ts - h.last < 5000) {
        const gap = (r.ts - h.last) / 1000;
        h.gaps.push(gap);
        if (sheet?.rangedSpeed) h.overSpeed.push(gap - sheet.rangedSpeed);
      }
      h.last = r.ts;
      h.start = undefined;
    } else if (r.event === "RANGE_DAMAGE" && sheet && r.dstLevel) {
      const t = attackTable(game.overrides.formula, sheet.level, r.dstLevel);
      h.hits++;
      if (r.crit) h.crits++;
      h.expected += Math.max(0, sheet.rangedCritPct - t.critSuppressionPct) / 100;
    }
  }
  return [...byHunter.values()].flatMap((h): ClaimRow[] => [
    ...(h.overSpeed.length
      ? [{
          claim: "Auto Shot interval",
          subject: h.name,
          source: "bow speed on the sheet (haste included)",
          claimed: "+0.00 sec",
          observed: `${h.overSpeed.length && median(h.overSpeed) >= 0 ? "+" : ""}${f(median(h.overSpeed))} sec median over the bow`,
          n: h.overSpeed.length,
          stat: { mean: mean(h.overSpeed), ci: ci95(h.overSpeed) },
          verdict: h.overSpeed.length < MIN_N ? "too few" : Math.abs(median(h.overSpeed)) <= 0.05 ? "fits" : "differs",
        } as const]
      : h.gaps.length
        ? [{ claim: "Auto Shot interval", subject: h.name, source: "bow speed (no sheet)", claimed: "", observed: `${f(median(h.gaps))} sec median`, n: h.gaps.length, verdict: "observed" as const }]
        : []),
    ...(h.windups.length
      ? [{ claim: "Auto Shot wind-up", subject: h.name, source: "cast start to shot", claimed: "", observed: `${f(median(h.windups))} sec median`, n: h.windups.length, stat: { mean: mean(h.windups), ci: ci95(h.windups) }, verdict: "observed" as const }]
      : []),
    ...(h.hits
      ? [{
          claim: "Auto Shot crit",
          subject: h.name,
          source: "sheet ranged crit less levels.ts crit suppression",
          claimed: `${f((100 * h.expected) / h.hits, 1)}%`,
          observed: rateText(h.crits, h.hits),
          n: h.hits,
          stat: { k: h.crits, n: h.hits },
          verdict: verdictOfRate((100 * h.expected) / h.hits, h.crits, h.hits),
        }]
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
        { claim: "pet miss", subject, source: "levels.ts attackTable, no hit", claimed: `${f(t.missPct, 1)}%`, observed: rateText(g.miss, g.swings), n: g.swings, stat: { k: g.miss, n: g.swings }, verdict: verdictOfRate(t.missPct, g.miss, g.swings) },
        { claim: "pet dodge", subject, source: "levels.ts attackTable", claimed: `${f(t.dodgePct, 1)}%`, observed: rateText(g.dodge, g.swings), n: g.swings, stat: { k: g.dodge, n: g.swings }, verdict: verdictOfRate(t.dodgePct, g.dodge, g.swings) },
      ];
    });
}

export type ClaimsScope = { hunter?: string | undefined; patches?: Patch[]; patch?: Patch | undefined };

// Every claim on the stored events; with a patch, only that patch's lines.
export function claims(game: GameData, db: Database, scope: ClaimsScope = {}): ClaimRow[] {
  const sheetAt = sheetsAt(db);
  const petSheet = petSheets(db, sheetAt);
  const rows = withLevels(loadRows(db, scope.hunter, scope.patches, scope.patch), petSheet);
  const petName = petNames(db);
  return [
    ...periodic(game, rows, sheetAt),
    ...critMultiplier(game, rows),
    ...armor(game, rows, sheetAt),
    ...petSwings(game, rows, petSheet, petName),
    ...petAttackTable(game, rows),
    ...petCrit(game, rows, petSheet, petName),
    ...petSpecials(game, rows, petSheet, petName),
    ...autoShot(game, rows, sheetAt),
  ];
}

export type Drift = { claim: string; subject: string; before: ClaimRow; after: ClaimRow; moved: boolean | undefined; change: string };

// Two proportions differ at 95% (pooled z test).
function ratesDiffer(a: { k: number; n: number }, b: { k: number; n: number }): boolean {
  const p = (a.k + b.k) / (a.n + b.n);
  const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n));
  return se > 0 && Math.abs(a.k / a.n - b.k / b.n) / se > 1.96;
}

// A side needs this many samples before a move counts: the rate test is not valid on fewer.
const DRIFT_MIN_N = 30;

// Each claim measured on both sides, matched by claim and subject. `moved` is whether the two
// differ at 95%; undefined when either side has too few samples to tell.
export function drift(before: ClaimRow[], after: ClaimRow[]): Drift[] {
  const key = (r: ClaimRow) => `${r.claim}|${r.subject}`;
  const old = new Map(before.map((r) => [key(r), r]));
  const out: Drift[] = [];
  for (const b of after) {
    const a = old.get(key(b));
    if (!a?.stat || !b.stat) continue;
    let moved: boolean | undefined;
    let change = "";
    if ("k" in a.stat && "k" in b.stat) {
      const pa = (100 * a.stat.k) / Math.max(1, a.stat.n);
      const pb = (100 * b.stat.k) / Math.max(1, b.stat.n);
      change = `${pb - pa >= 0 ? "+" : ""}${f(pb - pa, 1)} points`;
      if (a.stat.n >= DRIFT_MIN_N && b.stat.n >= DRIFT_MIN_N) moved = ratesDiffer(a.stat, b.stat);
    } else if ("mean" in a.stat && "mean" in b.stat) {
      const d = b.stat.mean - a.stat.mean;
      change = `${d >= 0 ? "+" : ""}${f(d, 3)}`;
      if (a.n >= DRIFT_MIN_N && b.n >= DRIFT_MIN_N && Number.isFinite(a.stat.ci) && Number.isFinite(b.stat.ci)) moved = Math.abs(d) > Math.hypot(a.stat.ci, b.stat.ci);
    }
    out.push({ claim: b.claim, subject: b.subject, before: a, after: b, moved, change });
  }
  return out;
}
