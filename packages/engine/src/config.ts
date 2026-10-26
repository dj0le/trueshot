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
    // Run speed in percent (Minor Speed boots); the highest of this and speed auras counts.
    runSpeedPct: z.number().default(0),
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
    // Enchants by slot, as SpellItemEnchantment ids (generated/enchants.json). A scope's damage
    // goes on the ranged weapon.
    enchants: z.record(z.enum(GEAR_SLOTS), z.number().int()).default({}),
    // Random suffixes by slot ("of Agility" items), as suffix ids (generated/suffixes.json).
    suffixes: z.record(z.enum(GEAR_SLOTS), z.number().int()).default({}),
    stats: Stats,
    // Needed when no ranged item is listed.
    rangedWeapon: z.object({ min: z.number(), max: z.number(), speed: z.number() }).optional(),
    // Arrows or bullets add their DPS to every ranged hit.
    ammoDps: z.number().default(0),
    quiverHastePct: z.number().default(0),
  }),
  // Where the hunter fights from: "ranged" (Auto Shot and shots), "melee" (white swings with the
  // melee weapons, Raptor Strike and the other melee abilities), or "weave": shooting, and walking
  // in for a melee swing between Auto Shots when the swing is ready. Each side's abilities are out
  // of range from the other.
  position: z.enum(["ranged", "melee", "weave"]).default("ranged"),
  // Melee weaving: where the hunter shoots from and walks in to, in yards, and the most a weave may
  // push the next Auto Shot back. Defaults follow wowsims/forever's hunter weave (PR 575): shoot
  // from just past the 11.67 yd minimum, walk in just inside melee range, 1.2 sec measured best.
  weave: z
    .object({
      shootRangeYd: z.number().default(12),
      meleeRangeYd: z.number().default(4.99),
      maxAutoShotDelayMs: z.number().min(0).default(1200),
    })
    .default({}),
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
      // Decides which Track spell the hunter keeps up (Improved Tracking). Mechanical and critter
      // targets cannot be tracked. Any trackable type gives the same result.
      creatureType: z
        .enum(["beast", "dragonkin", "demon", "elemental", "giant", "undead", "humanoid", "critter", "mechanical"])
        .default("humanoid"),
      // Sunder Armor, Faerie Fire, Curse of Recklessness and friends, summed.
      armorReduction: z.number().default(0),
    })
    .default({}),
  fight: z
    .object({
      // A fight-length preset from overrides.toml [fights] (dungeon-boss-30, raid-boss, ...), which
      // durationSec and durationVariancePct override. Without either, 180 sec every fight.
      preset: z.string().optional(),
      durationSec: z.number().positive().optional(),
      // Each iteration's length is drawn uniformly within this many percent of durationSec.
      durationVariancePct: z.number().min(0).max(50).optional(),
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
