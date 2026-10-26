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

// Hotfix fields that change one effect, and ones that change the spell's proc.
const EFFECT_FIELDS = ["basePoints", "apCoefficient", "miscValue", "classMask"] as const;
const PROC_FIELDS = ["procTypeMask", "procChance", "procPpm"] as const;

const Overrides = z.object({
  formula: z.object({
    rangedAttackPowerPerAgility: Value,
    rangedAttackPowerBase: Value,
    rangedAttackPowerPerLevel: Value,
    meleeAttackPowerPerStrength: Value,
    meleeAttackPowerPerAgility: Value,
    meleeAttackPowerPerLevel: Value,
    meleeAttackPowerBase: Value,
    normalizedOneHandSpeed: Value,
    normalizedDaggerSpeed: Value,
    normalizedTwoHandSpeed: Value,
    dualWieldMissPct: Value,
    runSpeedYdPerSec: Value,
    trapArmingMs: Value,
    offHandDamagePct: Value,
    attackPowerPerDps: Value,
    baseCritPct: Value,
    critDamageBonusPct: Value,
    armorConstantBase: Value,
    armorConstantPerLevel: Value,
    normalizedRangedSpeed: Value,
    critRatingPerPct: Value,
    hitRatingPerPct: Value,
    autoShotStandStillMs: Value,
    weaponProcPpm: Value,
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
  // Auras that raise a caster aura state the server sets (Expose Prey's activation, the dodge state
  // Mongoose Bite needs). Casting a spell that needs the state uses the aura up.
  auraState: z.array(z.object({ spell: z.number(), state: z.number(), ...provenance })),
  hotfix: z.array(
    z
      .object({
        spell: z.number(),
        // Effect fields (basePoints, apCoefficient, miscValue, classMask) need the effect; procTypeMask
        // is the spell's.
        effectIndex: z.number().optional(),
        basePoints: z.number().optional(),
        apCoefficient: z.number().optional(),
        // The effect's first misc value, such as a damage aura's school mask.
        miscValue: z.number().optional(),
        // Which of the class's spells a modifier aura reaches (all four words).
        classMask: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        // Which hits the spell's proc listens for (ProcFlag bits), and how often it fires: a chance
        // in percent, or procs per minute (scaled by weapon speed).
        procTypeMask: z.number().optional(),
        procChance: z.number().optional(),
        procPpm: z.number().optional(),
        ...provenance,
      })
      .refine(
        (h) => [...EFFECT_FIELDS, ...PROC_FIELDS].some((k) => h[k] !== undefined),
        `a hotfix needs one of ${[...EFFECT_FIELDS, ...PROC_FIELDS].join(", ")}`,
      )
      .refine(
        (h) => h.effectIndex !== undefined || EFFECT_FIELDS.every((k) => h[k] === undefined),
        "an effect hotfix needs effectIndex",
      ),
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
  const stale = (what: string, value: number) => {
    throw new Error(`hotfix: spell ${h.spell}${what} already has ${value} in the client; remove the override`);
  };
  let h: Overrides["hotfix"][number];
  for (h of o.hotfix) {
    const spell = spells[String(h.spell)];
    if (!spell) throw new Error(`hotfix: spell ${h.spell} is not in the client data`);
    if (h.procTypeMask !== undefined) {
      if (!spell.proc) throw new Error(`hotfix: spell ${h.spell} has no proc`);
      if (spell.proc.typeMask[0] === h.procTypeMask) stale(" proc typeMask", h.procTypeMask);
      spell.proc = { ...spell.proc, typeMask: [h.procTypeMask, spell.proc.typeMask[1]!] };
    }
    for (const [key, field] of [["procChance", "chance"], ["procPpm", "ppm"]] as const) {
      const value = h[key];
      if (value === undefined) continue;
      if (!spell.proc) throw new Error(`hotfix: spell ${h.spell} has no proc`);
      if (spell.proc[field] === value) stale(` proc ${field}`, value);
      spell.proc = { ...spell.proc, [field]: value };
    }
    if (h.effectIndex === undefined) continue;
    const effect = spell.effects.find((e) => e.index === h.effectIndex);
    if (!effect) throw new Error(`hotfix: spell ${h.spell} effect ${h.effectIndex} is not in the client data`);
    for (const key of ["basePoints", "apCoefficient"] as const) {
      const value = h[key];
      if (value === undefined) continue;
      if (effect[key] === value) stale(` effect ${h.effectIndex} ${key}`, value);
      effect[key] = value;
    }
    if (h.miscValue !== undefined) {
      if (effect.miscValue[0] === h.miscValue) stale(` effect ${h.effectIndex} miscValue`, h.miscValue);
      effect.miscValue = [h.miscValue, effect.miscValue[1]!];
    }
    if (h.classMask !== undefined) {
      if (h.classMask.every((m, i) => effect.classMask[i] === m)) stale(` effect ${h.effectIndex} classMask`, h.classMask[0]);
      effect.classMask = [...h.classMask];
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
