// Turns a config into a character: validated talents, the spells it knows, and its stats before
// any in-combat auras. Pure: everything comes in as arguments.
import type { HunterData, Item, Overrides, Spell, SpellEffect, Talent } from "@hunter-sim/data";
import { Aura, Stat } from "./enums";
import type { GEAR_SLOTS, SimConfig, StatBlock } from "./config";

// An effect with its value settled for the talent rank taken.
export type ResolvedEffect = SpellEffect & { value: number };

export type ActiveSpell = { spell: Spell; effects: ResolvedEffect[]; source: string };

export type Character = {
  config: SimConfig;
  level: number;
  // Talents (and later items) that are always on.
  passives: ActiveSpell[];
  // Highest rank known at this level, keyed by snake_case ability name.
  abilities: Map<string, Spell>;
  primary: Record<"strength" | "agility" | "stamina" | "intellect" | "spirit", number>;
  baseMana: number;
  maxMana: number;
  // Ranged attack power and crit from level, stats, gear and buffs. Talent passives and auras
  // add to them in combat.
  rangedAttackPower: number;
  critPct: number;
  hitPct: number;
  mp5: number;
  rangedWeapon: { min: number; max: number; speed: number };
  // What the equipped items do that the sim does not model (procs, set bonuses, odd equip effects).
  gearNotes: string[];
};

const ITEM_CATEGORY_OFFSET = 1_000_000;

// Inventory types each slot accepts.
const SLOT_TYPES: Record<(typeof GEAR_SLOTS)[number], number[]> = {
  head: [1],
  neck: [2],
  shoulder: [3],
  back: [16],
  chest: [5, 20],
  wrist: [9],
  hands: [10],
  waist: [6],
  legs: [7],
  feet: [8],
  finger1: [11],
  finger2: [11],
  trinket1: [12],
  trinket2: [12],
  mainHand: [13, 17, 21],
  offHand: [13, 14, 22, 23],
  ranged: [15, 25, 26],
};

// Item stats summed, ratings turned into percentages, on top of the config's own stat block.
function gearStats(
  items: Map<number, Item>,
  overrides: Overrides,
  config: SimConfig,
): { stats: StatBlock; rangedWeapon: Character["rangedWeapon"] | undefined; notes: string[] } {
  const stats = { ...config.gear.stats };
  const notes: string[] = [];
  let rangedWeapon: Character["rangedWeapon"] | undefined;
  for (const [slot, id] of Object.entries(config.gear.items) as [keyof typeof SLOT_TYPES, number][]) {
    const item = items.get(id);
    if (!item) throw new Error(`gear: item ${id} in ${slot} is not in items.json (hunter-usable, level 40+)`);
    if (!SLOT_TYPES[slot].includes(item.inventoryType)) throw new Error(`gear: ${item.name} does not go in ${slot}`);
    const s = item.stats;
    stats.strength += s.strength ?? 0;
    stats.agility += s.agility ?? 0;
    stats.stamina += s.stamina ?? 0;
    stats.intellect += s.intellect ?? 0;
    stats.spirit += s.spirit ?? 0;
    stats.attackPower += s.attackPower ?? 0;
    stats.rangedAttackPower += s.rangedAttackPower ?? 0;
    stats.critPct += (s.critPct ?? 0) + (s.critRating ?? 0) / overrides.formula.critRatingPerPct.value;
    stats.hitPct += (s.hitPct ?? 0) + (s.hitRating ?? 0) / overrides.formula.hitRatingPerPct.value;
    stats.mp5 += s.mp5 ?? 0;
    if (slot === "ranged" && item.weapon) rangedWeapon = item.weapon;
    if (item.source === "classic") notes.push(`${item.name}: not in the Forever client, Classic Era stats used`);
    if (item.procSpells.length) notes.push(`${item.name}: chance-on-hit effect not simulated`);
    for (const e of item.unparsedEquip) notes.push(`${item.name}: equip effect "${e}" not simulated`);
  }
  return { stats, rangedWeapon, notes };
}

export const snake = (name: string) =>
  name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

export function resolveEffects(spell: Spell, talent?: Talent, rank?: number): ResolvedEffect[] {
  return spell.effects.map((e) => {
    const perRank = talent?.rankEffects.find((r) => r.effectIndex === e.index);
    const value = perRank && rank ? (perRank.values[rank - 1] ?? e.basePoints) : e.basePoints;
    return { ...e, value };
  });
}

// The highest rank of an ability known at a level.
export function knownRank(data: HunterData, ability: HunterData["abilities"][number], level: number): Spell | undefined {
  const rank = ability.ranks.filter((r) => r.level <= level).at(-1);
  return rank && data.spells[String(rank.spellId)];
}

function validateTalents(data: HunterData, config: SimConfig): Talent[] {
  const errors: string[] = [];
  const chosen: Talent[] = [];
  const pointsInTree = new Map<string, number>();

  for (const [name, rank] of Object.entries(config.talents)) {
    if (rank === 0) continue;
    const t = data.talents.find((x) => x.name === name);
    if (!t) {
      errors.push(`unknown talent "${name}"`);
      continue;
    }
    if (rank > t.maxRank) errors.push(`${name}: rank ${rank} but the talent has ${t.maxRank}`);
    chosen.push(t);
    pointsInTree.set(t.tree, (pointsInTree.get(t.tree) ?? 0) + rank);
  }

  const total = [...pointsInTree.values()].reduce((a, b) => a + b, 0);
  const available = Math.max(0, config.level - 9);
  if (total > available) errors.push(`${total} talent points spent, level ${config.level} has ${available}`);

  for (const t of chosen) {
    // Row n needs 5 * (n - 1) points spent in rows above it in the same tree.
    const above = chosen
      .filter((o) => o.tree === t.tree && o.row < t.row)
      .reduce((sum, o) => sum + config.talents[o.name]!, 0);
    if (above < 5 * (t.row - 1)) errors.push(`${t.name} needs ${5 * (t.row - 1)} points above it in ${t.tree}, has ${above}`);
    for (const req of t.requires) {
      const reqTalent = data.talents.find((x) => x.name === req)!;
      if ((config.talents[req] ?? 0) < reqTalent.maxRank) errors.push(`${t.name} requires ${req} at max rank`);
    }
  }

  if (errors.length > 0) throw new Error(`talents:\n  ${errors.join("\n  ")}`);
  return chosen;
}

// Talents whose effects depend on whether a pet is out. Their dummy auras are scripted here.
function passiveApplies(talent: Talent, petActive: boolean): boolean {
  if (talent.name === "Lone Wolf") return !petActive;
  if (talent.name === "Focused Fire") return petActive;
  return true;
}

// Focused Fire's dummy aura, read as what its tooltip says: all damage done +N% for hunter and pet.
function scriptedEffects(talent: Talent, effects: ResolvedEffect[]): ResolvedEffect[] {
  if (talent.name !== "Focused Fire") return effects;
  return effects.map((e) => (e.aura === Aura.Dummy ? { ...e, aura: Aura.ModDamagePercentDone, miscValue: [127, 0] } : e));
}

export function buildCharacter(data: HunterData, overrides: Overrides, items: Map<number, Item>, config: SimConfig): Character {
  const f = overrides.formula;
  const raceKey = Object.keys(overrides.races).find((r) => config.race.startsWith(r));
  if (!raceKey) throw new Error(`no base stats for race "${config.race}" in overrides.toml`);
  const race = overrides.races[raceKey]!;

  const passives: ActiveSpell[] = [];
  for (const t of validateTalents(data, config)) {
    if (!t.passive || !passiveApplies(t, config.pet.active)) continue;
    const spell = data.spells[String(t.spellId)]!;
    passives.push({ spell, effects: scriptedEffects(t, resolveEffects(spell, t, config.talents[t.name])), source: t.name });
  }

  // Abilities a talent teaches are only known with the talent taken.
  const taughtByTalent = new Set(data.talents.filter((t) => !t.passive).map((t) => t.name));
  const abilities = new Map<string, Spell>();
  for (const a of data.abilities) {
    if (a.tab === "Pets" || (taughtByTalent.has(a.name) && !config.talents[a.name])) continue;
    const known = knownRank(data, a, config.level);
    if (known) abilities.set(snake(a.name), known);
  }

  // Consumables act like spells with their item's cooldown, off the GCD. Item cooldown categories
  // are their own number space, so they are offset clear of spell categories.
  for (const c of data.consumables) {
    const spell = data.spells[String(c.spellId)]!;
    abilities.set(snake(c.name), {
      ...spell,
      name: c.name,
      gcdMs: 0,
      cooldownMs: 0,
      category: ITEM_CATEGORY_OFFSET + c.categoryId,
      categoryCooldownMs: c.cooldownMs,
    });
  }

  const worn = gearStats(items, overrides, config);
  const gear = worn.stats;
  const buffs = config.buffs;
  const rangedWeapon = worn.rangedWeapon ?? config.gear.rangedWeapon;
  if (!rangedWeapon) throw new Error("gear: no ranged weapon; add gear.items.ranged or gear.rangedWeapon");
  const sum = (key: keyof StatBlock) => gear[key] + buffs[key];

  // Percentage stat bonuses (Lightning Reflexes) from passive auras.
  const statPct = [0, 0, 0, 0, 0];
  for (const p of passives) {
    for (const e of p.effects) {
      if (e.aura !== Aura.ModTotalStatPercentage) continue;
      // The stat is a bit mask in the second misc value, or an index (-1 = all) in the first.
      const mask = e.miscValue[1];
      for (let s = 0; s < 5; s++) {
        const hit = mask !== 0 ? (mask & (1 << s)) !== 0 : e.miscValue[0] === -1 || e.miscValue[0] === s;
        if (hit) statPct[s]! += e.value;
      }
    }
  }
  const stat = (i: number, key: keyof StatBlock) => Math.floor((race.stats[i]! + sum(key)) * (1 + statPct[i]! / 100));
  const primary = {
    strength: stat(Stat.Strength, "strength"),
    agility: stat(Stat.Agility, "agility"),
    stamina: stat(Stat.Stamina, "stamina"),
    intellect: stat(Stat.Intellect, "intellect"),
    spirit: stat(Stat.Spirit, "spirit"),
  };

  const baseMana = overrides.base.mana.value;
  const int = primary.intellect;
  const maxMana = baseMana + Math.min(20, int) + Math.max(0, int - 20) * f.manaPerIntellect.value;

  const rangedAttackPower =
    config.level * f.rangedAttackPowerPerLevel.value +
    primary.agility * f.rangedAttackPowerPerAgility.value +
    f.rangedAttackPowerBase.value +
    sum("rangedAttackPower");

  const critPct = f.baseCritPct.value + primary.agility / f.agilityPerCrit.value + sum("critPct");

  return {
    config,
    level: config.level,
    passives,
    abilities,
    primary,
    baseMana,
    maxMana,
    rangedAttackPower,
    critPct,
    hitPct: sum("hitPct"),
    mp5: sum("mp5"),
    rangedWeapon,
    gearNotes: worn.notes,
  };
}

// A talent's value for one effect at the rank taken, or 0 when not taken.
export function talentValue(data: HunterData, config: SimConfig, name: string, effectIndex: number): number {
  const rank = config.talents[name] ?? 0;
  if (rank === 0) return 0;
  const t = data.talents.find((x) => x.name === name)!;
  return resolveEffects(data.spells[String(t.spellId)]!, t, rank).find((e) => e.index === effectIndex)!.value;
}
