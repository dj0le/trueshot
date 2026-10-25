// Loads overrides.toml, validates it, and applies the hotfixes onto the generated client data.
import { join } from "node:path";
import { z } from "zod";
import type { HunterData } from "./schema";

const Confidence = z.enum(["confirmed", "reported", "classic", "guess"]);
export type Confidence = z.infer<typeof Confidence>;

const provenance = { confidence: Confidence, source: z.string().min(1) };
const Value = z.object({ value: z.number(), ...provenance });
const Range = z.object({ min: z.number(), max: z.number(), ...provenance });

const Table = z.object({ values: z.array(z.number()), ...provenance });
const StatRow = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]);

// levels.toml: values by level, from firstLevel on.
const Levels = z.object({
  firstLevel: z.number().int(),
  hunter: z.object({
    baseMana: Table,
    agilityPerCrit: Table,
    // str, agi, sta, int, spi
    races: z.record(z.object({ stats: z.array(StatRow), ...provenance })),
  }),
  pet: z.object({ attackPower: Table }),
  creatureArmor: Table,
});
export type Levels = z.infer<typeof Levels>;

const Overrides = z.object({
  formula: z.object({
    rangedAttackPowerPerAgility: Value,
    rangedAttackPowerBase: Value,
    rangedAttackPowerPerLevel: Value,
    attackPowerPerDps: Value,
    baseCritPct: Value,
    critDamageBonusPct: Value,
    armorConstantBase: Value,
    armorConstantPerLevel: Value,
    normalizedRangedSpeed: Value,
    critRatingPerPct: Value,
    hitRatingPerPct: Value,
    autoShotStandStillMs: Value,
    rangedHasteAffectsCastTime: Value,
    manaPerTickBase: Value,
    spiritPerManaPerTick: Value,
    manaPerIntellect: Value,
    critSuppressionPerLevelPct: Value,
    auraCritSuppressionPct: Value,
  }),
  // Target presets as levels above the hunter; the attack table follows from the difference.
  targets: z.record(z.object({ levelOffset: z.number().int(), ...provenance })),
  pet: z.object({
    inheritRangedAttackPowerPct: Value,
    // Damage per 2.0 sec swing at base attack power, per pet level.
    baseDamagePerLevel: Range,
    focusPerSecond: Value,
    happinessDamagePct: Value,
    baseCritPct: Value,
    attackSpeedSec: Value,
    hawk: z.object({ arrivalSec: Value, durationSec: Value, maxActive: Value, hitPctOfPetMelee: Value, attackIntervalSec: Value }),
  }),
  // Buffs and debuffs other players keep up, by preset name, as client spell ids.
  support: z.record(z.object({ spells: z.array(z.number()), ...provenance })),
  hotfix: z.array(
    z
      .object({
        spell: z.number(),
        effectIndex: z.number(),
        basePoints: z.number().optional(),
        apCoefficient: z.number().optional(),
        ...provenance,
      })
      .refine((h) => h.basePoints !== undefined || h.apCoefficient !== undefined, "a hotfix needs basePoints or apCoefficient"),
  ),
});
export type Overrides = z.infer<typeof Overrides> & { levels: Levels };

export const OVERRIDES_PATH = join(import.meta.dir, "..", "overrides.toml");
export const LEVELS_PATH = join(import.meta.dir, "..", "levels.toml");

export async function loadOverrides(path = OVERRIDES_PATH, levelsPath = LEVELS_PATH): Promise<Overrides> {
  const overrides = Overrides.parse(Bun.TOML.parse(await Bun.file(path).text()));
  const levels = Levels.parse(Bun.TOML.parse(await Bun.file(levelsPath).text()));
  const hunterLevels = 60 - levels.firstLevel + 1;
  const check = (name: string, n: number, want: number) => {
    if (n !== want) throw new Error(`levels.toml: ${name} has ${n} levels, expected ${want}`);
  };
  check("hunter.baseMana", levels.hunter.baseMana.values.length, hunterLevels);
  check("hunter.agilityPerCrit", levels.hunter.agilityPerCrit.values.length, hunterLevels);
  check("pet.attackPower", levels.pet.attackPower.values.length, hunterLevels);
  check("creatureArmor", levels.creatureArmor.values.length, hunterLevels + 3);
  for (const [race, r] of Object.entries(levels.hunter.races)) check(`hunter.races.${race}`, r.stats.length, hunterLevels);
  return { ...overrides, levels };
}

// A level table's value at a level.
export function atLevel(levels: Levels, values: readonly number[], level: number): number {
  const v = values[level - levels.firstLevel];
  if (v === undefined) throw new Error(`level ${level} is outside the level tables (${levels.firstLevel} and up)`);
  return v;
}

// Returns a copy of the data with each hotfix applied. Fails loudly when a hotfix points at a spell
// or effect that does not exist, or when the client already carries the hotfixed value (the
// override is then stale and should be deleted).
export function applyHotfixes(data: HunterData, o: Overrides): HunterData {
  const spells = structuredClone(data.spells);
  for (const h of o.hotfix) {
    const effect = spells[String(h.spell)]?.effects.find((e) => e.index === h.effectIndex);
    if (!effect) throw new Error(`hotfix: spell ${h.spell} effect ${h.effectIndex} is not in the client data`);
    for (const key of ["basePoints", "apCoefficient"] as const) {
      const value = h[key];
      if (value === undefined) continue;
      if (effect[key] === value) {
        throw new Error(`hotfix: spell ${h.spell} effect ${h.effectIndex} already has ${value} (${key}) in the client; remove the override`);
      }
      effect[key] = value;
    }
  }
  return { ...data, spells };
}

// Every override that is not confirmed, flattened for reports.
export function unconfirmed(o: Overrides): { key: string; confidence: Confidence; source: string }[] {
  const out: { key: string; confidence: Confidence; source: string }[] = [];
  const visit = (key: string, v: unknown) => {
    if (v && typeof v === "object" && "confidence" in v && "source" in v) {
      const p = v as { confidence: Confidence; source: string };
      if (p.confidence !== "confirmed") out.push({ key, confidence: p.confidence, source: p.source });
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => visit(`${key}[${i}]`, x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(key ? `${key}.${k}` : k, x);
  };
  visit("", o);
  return out;
}
