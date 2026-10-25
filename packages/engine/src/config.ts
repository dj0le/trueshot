// A sim setup: who is fighting, with what, against what, and how they play.
import { z } from "zod";

const Stats = z
  .object({
    strength: z.number().default(0),
    agility: z.number().default(0),
    stamina: z.number().default(0),
    intellect: z.number().default(0),
    spirit: z.number().default(0),
    attackPower: z.number().default(0),
    rangedAttackPower: z.number().default(0),
    critPct: z.number().default(0),
    hitPct: z.number().default(0),
    // Ranged haste in percent, multiplying with the quiver and every haste aura.
    hastePct: z.number().default(0),
    mp5: z.number().default(0),
  })
  .default({});
export type StatBlock = z.infer<typeof Stats>;

export const GEAR_SLOTS = [
  "head",
  "neck",
  "shoulder",
  "back",
  "chest",
  "wrist",
  "hands",
  "waist",
  "legs",
  "feet",
  "finger1",
  "finger2",
  "trinket1",
  "trinket2",
  "mainHand",
  "offHand",
  "ranged",
] as const;

// pet: a pet ability the same macro sends (Intimidation with Bite), used then if the pet can.
const Action = z.object({ action: z.string(), if: z.string().optional(), pet: z.string().optional() });
export type ActionConfig = z.infer<typeof Action>;

export const SimConfig = z.object({
  name: z.string().default("unnamed"),
  level: z.number().int().min(10).max(60).default(60),
  race: z.string(),
  talents: z.record(z.number().int().min(0)).default({}),
  gear: z.object({
    // Equipped items by slot (head = 252605). Their stats add to `stats`, which then covers
    // whatever items cannot express yet: enchants, set bonuses.
    items: z.record(z.enum(GEAR_SLOTS), z.number().int()).default({}),
    stats: Stats,
    // Needed when no ranged item is listed.
    rangedWeapon: z.object({ min: z.number(), max: z.number(), speed: z.number() }).optional(),
    // Arrows or bullets add their DPS to every ranged hit.
    ammoDps: z.number().default(0),
    quiverHastePct: z.number().default(0),
  }),
  // Raid buffs and consumables, flattened to stats.
  buffs: Stats,
  // What other players keep up: "solo", or a preset from overrides.toml [support].
  support: z.string().default("solo"),
  pet: z
    .object({
      active: z.boolean().default(false),
      family: z.string().default("Cat"),
      // Ability priority by snake_case name. Defaults to the family's damage abilities.
      abilities: z.array(z.string()).optional(),
      // Share of the fight the pet spends attacking. It drops out for good after that (killed by
      // the boss, or pulled back), which is what a boss fight's pet trouble costs on average.
      attackingPct: z.number().min(0).max(100).default(100),
    })
    .default({}),
  target: z
    .object({
      preset: z.enum(["normal", "elite", "boss"]).default("boss"),
      // A specific creature instead of the preset's: its level, and its armor (by default a
      // warrior-class creature's at that level).
      level: z.number().int().min(1).max(63).optional(),
      armor: z.number().min(0).optional(),
      // Sunder Armor, Faerie Fire, Curse of Recklessness and friends, summed.
      armorReduction: z.number().default(0),
    })
    .default({}),
  fight: z
    .object({
      durationSec: z.number().positive().default(180),
      // Each iteration's length is drawn uniformly within this many percent of durationSec.
      durationVariancePct: z.number().min(0).max(50).default(0),
      iterations: z.number().int().positive().default(1000),
      seed: z.string().default("hunter-sim"),
    })
    .default({}),
  rotation: z.object({
    // Applied before the pull, free: aspects, Hunter's Mark, and so on.
    precombat: z.array(z.string()).default([]),
    actions: z.array(Action),
  }),
});
export type SimConfig = z.infer<typeof SimConfig>;
export type SimConfigInput = z.input<typeof SimConfig>;
