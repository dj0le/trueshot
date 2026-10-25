// Loads overrides.toml, validates it, and applies the hotfixes onto the generated client data.
import { join } from "node:path";
import { z } from "zod";
import type { HunterData } from "./schema";

const Confidence = z.enum(["confirmed", "reported", "classic", "guess"]);
export type Confidence = z.infer<typeof Confidence>;

const provenance = { confidence: Confidence, source: z.string().min(1) };
const Value = z.object({ value: z.number(), ...provenance });
const Range = z.object({ min: z.number(), max: z.number(), ...provenance });

const Overrides = z.object({
  base: z.object({ health: Value, mana: Value }),
  races: z.record(z.object({ stats: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]), ...provenance })),
  formula: z.object({
    rangedAttackPowerPerAgility: Value,
    rangedAttackPowerBase: Value,
    rangedAttackPowerPerLevel: Value,
    agilityPerCrit: Value,
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
  }),
  targets: z.record(
    z.object({
      level: z.number(),
      armor: z.number(),
      baseMissPct: z.number(),
      hitPenaltyPct: z.number(),
      critSuppressionPct: z.number(),
      ...provenance,
    }),
  ),
  pet: z.object({
    inheritRangedAttackPowerPct: Value,
    baseAttackPower: Value,
    baseDamage: Range,
    focusPerSecond: Value,
    happinessDamagePct: Value,
    missPct: Value,
    dodgePct: Value,
    glancingPct: Value,
    glancingPenaltyPct: Value,
    baseCritPct: Value,
    attackSpeedSec: Value,
    hawk: z.object({ durationSec: Value, maxActive: Value, hitPctOfPetMelee: Value, attackIntervalSec: Value }),
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
export type Overrides = z.infer<typeof Overrides>;

export const OVERRIDES_PATH = join(import.meta.dir, "..", "overrides.toml");

export async function loadOverrides(path = OVERRIDES_PATH): Promise<Overrides> {
  return Overrides.parse(Bun.TOML.parse(await Bun.file(path).text()));
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
