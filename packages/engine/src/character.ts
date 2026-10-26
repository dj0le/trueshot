// Turns a config into a character: validated talents, the spells it knows, and its stats before
// any in-combat auras. Pure: everything comes in as arguments.
import { atLevel, type Enchant, type HunterData, type Item, type Overrides, type Spell, type SpellEffect, type Suffix, type Talent } from "@hunter-sim/data";
import { Aura, Stat } from "./enums";
import type { GEAR_SLOTS, SimConfig, StatBlock } from "./config";

// An effect with its value settled for the talent rank taken.
export type ResolvedEffect = SpellEffect & { value: number };

export type ActiveSpell = { spell: Spell; effects: ResolvedEffect[]; source: string };

// A melee weapon in hand: its damage, its speed and the fixed speed normalized attacks use, and its
// chance-on-hit spells.
export type MeleeWeapon = { name: string; min: number; max: number; speed: number; normalizedSpeed: number; procs: Spell[] };

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
  // The part of critPct from agility; the rest counts as aura crit against high-level targets.
  agilityCritPct: number;
  hitPct: number;
  hastePct: number;
  runSpeedPct: number;
  mp5: number;
  rangedWeapon: { min: number; max: number; speed: number };
  // Melee attack power before auras, and the weapons for melee position (off hand: dual wielding).
  meleeAttackPower: number;
  mainHand: MeleeWeapon | null;
  offHand: MeleeWeapon | null;
  // What the equipped items do that the sim does not model (procs, set bonuses, odd equip effects).
  gearNotes: string[];
  // The ranged weapon's chance-on-hit spells.
  weaponProcs: Spell[];
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

// Item and enchant stats summed, ratings turned into percentages, on top of the config's own stat block.
function gearStats(
  items: Map<number, Item>,
  enchants: Map<number, Enchant>,
  suffixes: Map<number, Suffix>,
  overrides: Overrides,
  config: SimConfig,
): { stats: StatBlock; rangedWeapon: Character["rangedWeapon"] | undefined; weaponDamage: Partial<Record<string, number>>; notes: string[] } {
  const stats = { ...config.gear.stats };
  // Flat damage enchants by slot (a scope on the ranged weapon, +damage on a melee weapon).
  const weaponDamage: Partial<Record<string, number>> = {};
  const notes: string[] = [];
  let rangedWeapon: Character["rangedWeapon"] | undefined;
  const add = (s: Item["stats"]) => {
    stats.strength += s.strength ?? 0;
    stats.agility += s.agility ?? 0;
    stats.stamina += s.stamina ?? 0;
    stats.intellect += s.intellect ?? 0;
    stats.spirit += s.spirit ?? 0;
    stats.attackPower += s.attackPower ?? 0;
    stats.rangedAttackPower += s.rangedAttackPower ?? 0;
    stats.critPct += (s.critPct ?? 0) + (s.critRating ?? 0) / overrides.formula.critRatingPerPct.value;
    stats.hitPct += (s.hitPct ?? 0) + (s.hitRating ?? 0) / overrides.formula.hitRatingPerPct.value;
    stats.hastePct += s.hastePct ?? 0;
    stats.runSpeedPct = Math.max(stats.runSpeedPct, s.runSpeedPct ?? 0);
    stats.mp5 += s.mp5 ?? 0;
  };
  for (const [slot, id] of Object.entries(config.gear.items) as [keyof typeof SLOT_TYPES, number][]) {
    const item = items.get(id);
    if (!item) throw new Error(`gear: item ${id} in ${slot} is not in items.json (hunter-usable, uncommon or better)`);
    if (item.requiredLevel > config.level) throw new Error(`gear: ${item.name} needs level ${item.requiredLevel}`);
    if (!SLOT_TYPES[slot].includes(item.inventoryType)) throw new Error(`gear: ${item.name} does not go in ${slot}`);
    add(item.stats);
    if (slot === "ranged" && item.weapon) rangedWeapon = { ...item.weapon };
    if (item.source === "classic") notes.push(`${item.name}: not in the Forever client, Classic Era stats used`);
    // Equip spells with effects run as passives (their unknown auras are reported then); the rest
    // have nothing to run.
    const unrun = item.unparsedEquip.length - item.passiveSpells.length;
    if (unrun > 0) notes.push(`${item.name}: ${unrun} equip effect(s) with no client effects, not simulated`);
  }
  for (const [slot, id] of Object.entries(config.gear.suffixes) as [keyof typeof SLOT_TYPES, number][]) {
    const suffix = suffixes.get(id);
    if (!suffix) throw new Error(`gear: suffix ${id} on ${slot} is not in suffixes.json`);
    if (!config.gear.items[slot]) throw new Error(`gear: suffix ${suffix.name} on ${slot}, which has no item`);
    for (const e of suffix.enchants) add(enchants.get(e)!.stats);
  }
  for (const [slot, id] of Object.entries(config.gear.enchants) as [keyof typeof SLOT_TYPES, number][]) {
    const enchant = enchants.get(id);
    if (!enchant) throw new Error(`gear: enchant ${id} on ${slot} is not in enchants.json (stat and scope enchants)`);
    add(enchant.stats);
    if (enchant.weaponDamage) {
      // A scope adds its damage to every shot of the weapon it is on.
      weaponDamage[slot] = (weaponDamage[slot] ?? 0) + enchant.weaponDamage;
      if (slot === "ranged" && rangedWeapon) {
        rangedWeapon.min += enchant.weaponDamage;
        rangedWeapon.max += enchant.weaponDamage;
      }
    }
    for (const u of enchant.unparsed) notes.push(`${enchant.name} on ${slot}: "${u}" not simulated`);
  }
  return { stats, rangedWeapon, weaponDamage, notes };
}

export const snake = (name: string) =>
  name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

// A spell's effects without a talent rank, built once per spell; callers copy before changing them.
const baseEffects = new WeakMap<Spell, ResolvedEffect[]>();

export function resolveEffects(spell: Spell, talent?: Talent, rank?: number): ResolvedEffect[] {
  if (!talent) {
    let cached = baseEffects.get(spell);
    if (!cached) baseEffects.set(spell, (cached = spell.effects.map((e) => ({ ...e, value: e.basePoints }))));
    return cached;
  }
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

// What is wrong with a talent build at a level, or nothing. Taken talents come back in `chosen`.
export function talentErrors(data: HunterData, level: number, talents: Record<string, number>): { errors: string[]; chosen: Talent[] } {
  const errors: string[] = [];
  const chosen: Talent[] = [];
  const pointsInTree = new Map<string, number>();

  for (const [name, rank] of Object.entries(talents)) {
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
  const available = talentPoints(level);
  if (total > available) errors.push(`${total} talent points spent, level ${level} has ${available}`);

  for (const t of chosen) {
    // Row n needs 5 * (n - 1) points spent in rows above it in the same tree.
    const above = chosen
      .filter((o) => o.tree === t.tree && o.row < t.row)
      .reduce((sum, o) => sum + talents[o.name]!, 0);
    if (above < 5 * (t.row - 1)) errors.push(`${t.name} needs ${5 * (t.row - 1)} points above it in ${t.tree}, has ${above}`);
    for (const req of t.requires) {
      const reqTalent = data.talents.find((x) => x.name === req)!;
      if ((talents[req] ?? 0) < reqTalent.maxRank) errors.push(`${t.name} requires ${req} at max rank`);
    }
  }
  return { errors, chosen };
}

export const talentPoints = (level: number) => Math.max(0, level - 9);

function validateTalents(data: HunterData, config: SimConfig): Talent[] {
  const { errors, chosen } = talentErrors(data, config.level, config.talents);
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

// A talent whose ranks set its proc trigger's value ("a 10% chance" at rank 2) keeps its chance
// there, while the spell's own proc chance stays at 100 (Expose Prey, Resourcefulness).
function withRankProcChance(spell: Spell, talent: Talent, effects: ResolvedEffect[]): Spell {
  const trigger = effects.find((e) => e.aura === Aura.ProcTriggerSpell && talent.rankEffects.some((r) => r.effectIndex === e.index));
  return trigger && spell.proc ? { ...spell, proc: { ...spell.proc, chance: trigger.value } } : spell;
}

// Every action a rotation can name, whether or not this character knows it. Keep in step with the
// ability sources buildCharacter assembles below.
export function actionNames(data: HunterData, items: Map<number, Item>): Set<string> {
  return new Set([
    ...data.abilities.filter((a) => a.tab !== "Pets").map((a) => snake(a.name)),
    ...data.consumables.map((c) => snake(c.name)),
    ...data.racials.filter((r) => r.active).map((r) => snake(r.name)),
    ...[...items.values()].filter((i) => i.useSpells.length).map((i) => snake(i.name)),
  ]);
}

// Set bonuses the worn items turn on, as passives. A piece counts once however many slots hold it.
function setBonuses(data: HunterData, config: SimConfig): ActiveSpell[] {
  const worn = new Set(Object.values(config.gear.items));
  return data.itemSets.flatMap((set) => {
    const pieces = set.items.filter((id) => worn.has(id)).length;
    return set.bonuses
      .filter((b) => b.threshold <= pieces)
      .map((b) => {
        const spell = data.spells[String(b.spellId)]!;
        return { spell, effects: resolveEffects(spell), source: `${set.name} (${b.threshold})` };
      });
  });
}

export function buildCharacter(
  data: HunterData,
  overrides: Overrides,
  items: Map<number, Item>,
  enchants: Map<number, Enchant>,
  config: SimConfig,
  suffixes: Map<number, Suffix> = new Map(),
): Character {
  const f = overrides.formula;
  const lv = overrides.levels;
  const raceKey = Object.keys(lv.hunter.races).find((r) => config.race.startsWith(r));
  if (!raceKey) throw new Error(`no base stats for race "${config.race}" in levels.toml`);
  const raceStats = lv.hunter.races[raceKey]!.stats[config.level - lv.firstLevel]!;

  const passives: ActiveSpell[] = [];
  for (const t of validateTalents(data, config)) {
    if (!t.passive || !passiveApplies(t, config.pet.active)) continue;
    const spell = data.spells[String(t.spellId)]!;
    const effects = scriptedEffects(t, resolveEffects(spell, t, config.talents[t.name]));
    passives.push({ spell: withRankProcChance(spell, t, effects), effects, source: t.name });
  }

  // Abilities a talent teaches are only known with the talent taken.
  const taughtByTalent = new Set(data.talents.filter((t) => !t.passive).map((t) => t.name));
  const abilities = new Map<string, Spell>();
  for (const a of data.abilities) {
    if (a.tab === "Pets" || (taughtByTalent.has(a.name) && !config.talents[a.name])) continue;
    const known = knownRank(data, a, config.level);
    if (known) abilities.set(snake(a.name), known);
  }

  // Racials: passive ones are always on, active ones are cast like abilities. Both Skyborne
  // variants carry Wind Blessed, so racials are matched on the race name's start.
  const seen = new Set<number>();
  for (const r of data.racials.filter((r) => r.race.startsWith(config.race))) {
    if (seen.has(r.spellId)) continue;
    seen.add(r.spellId);
    const spell = data.spells[String(r.spellId)]!;
    if (r.active) abilities.set(snake(r.name), spell);
    else passives.push({ spell, effects: resolveEffects(spell), source: r.name });
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

  passives.push(...setBonuses(data, config));

  // Worn items: equip spells that are not plain stats run as passives, and on-use effects become
  // off-GCD actions named after the item, with its cooldown and its category's shared lockout.
  for (const id of new Set(Object.values(config.gear.items))) {
    const item = items.get(id);
    if (!item) continue;
    for (const spellId of item.passiveSpells) {
      const spell = data.spells[String(spellId)]!;
      passives.push({ spell, effects: resolveEffects(spell), source: item.name });
    }
    for (const u of item.useSpells) {
      const spell = data.spells[String(u.spellId)]!;
      abilities.set(snake(item.name), {
        ...spell,
        name: item.name,
        gcdMs: 0,
        cooldownMs: u.cooldownMs,
        category: u.categoryId ? ITEM_CATEGORY_OFFSET + u.categoryId : 0,
        categoryCooldownMs: u.categoryId ? u.categoryCooldownMs : 0,
      });
    }
  }

  const worn = gearStats(items, enchants, suffixes, overrides, config);
  const gear = worn.stats;
  const buffs = config.buffs;
  const rangedWeapon = worn.rangedWeapon ?? config.gear.rangedWeapon;
  if (!rangedWeapon) throw new Error("gear: no ranged weapon; add gear.items.ranged or gear.rangedWeapon");
  const sum = (key: keyof StatBlock) => gear[key] + buffs[key];

  // Flat (set bonuses) and percentage (Lightning Reflexes) stat bonuses from passive auras, and mana
  // regen.
  const statFlat = [0, 0, 0, 0, 0];
  const statPct = [0, 0, 0, 0, 0];
  let passiveMp5 = 0;
  for (const p of passives) {
    for (const e of p.effects) {
      if (e.aura === Aura.ModStat) {
        for (let s = 0; s < 5; s++) if (e.miscValue[0] === -1 || e.miscValue[0] === s) statFlat[s]! += e.value;
      }
      if (e.aura === Aura.ModPowerRegen && e.miscValue[0] === 0) passiveMp5 += e.value;
      if (e.aura !== Aura.ModTotalStatPercentage) continue;
      // The stat is a bit mask in the second misc value, or an index (-1 = all) in the first.
      const mask = e.miscValue[1];
      for (let s = 0; s < 5; s++) {
        const hit = mask !== 0 ? (mask & (1 << s)) !== 0 : e.miscValue[0] === -1 || e.miscValue[0] === s;
        if (hit) statPct[s]! += e.value;
      }
    }
  }
  const stat = (i: number, key: keyof StatBlock) => Math.floor((raceStats[i]! + sum(key) + statFlat[i]!) * (1 + statPct[i]! / 100));
  const primary = {
    strength: stat(Stat.Strength, "strength"),
    agility: stat(Stat.Agility, "agility"),
    stamina: stat(Stat.Stamina, "stamina"),
    intellect: stat(Stat.Intellect, "intellect"),
    spirit: stat(Stat.Spirit, "spirit"),
  };

  const baseMana = atLevel(lv, lv.hunter.baseMana.values, config.level);
  const int = primary.intellect;
  const maxMana = baseMana + Math.min(20, int) + Math.max(0, int - 20) * f.manaPerIntellect.value;

  const rangedAttackPower =
    config.level * f.rangedAttackPowerPerLevel.value +
    primary.agility * f.rangedAttackPowerPerAgility.value +
    f.rangedAttackPowerBase.value +
    sum("rangedAttackPower");

  const meleeAttackPower =
    config.level * f.meleeAttackPowerPerLevel.value +
    primary.strength * f.meleeAttackPowerPerStrength.value +
    primary.agility * f.meleeAttackPowerPerAgility.value +
    f.meleeAttackPowerBase.value +
    sum("attackPower");

  const meleeWeapon = (slot: "mainHand" | "offHand"): MeleeWeapon | null => {
    const item = items.get(config.gear.items[slot] ?? 0);
    const w = item?.weapon;
    if (!item || !w || (w.kind !== "oneHand" && w.kind !== "twoHand")) return null;
    const dagger = item.classId === 2 && item.subclassId === 15;
    const normalized = w.kind === "twoHand" ? f.normalizedTwoHandSpeed : dagger ? f.normalizedDaggerSpeed : f.normalizedOneHandSpeed;
    const bonus = worn.weaponDamage[slot] ?? 0;
    return {
      name: item.name,
      min: w.min + bonus,
      max: w.max + bonus,
      speed: w.speed,
      normalizedSpeed: normalized.value,
      procs: item.procSpells.flatMap((id) => data.spells[String(id)] ?? []),
    };
  };

  const agilityCritPct = primary.agility / atLevel(lv, lv.hunter.agilityPerCrit.values, config.level);
  const critPct = f.baseCritPct.value + agilityCritPct + sum("critPct");

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
    agilityCritPct,
    hitPct: sum("hitPct"),
    hastePct: sum("hastePct"),
    runSpeedPct: Math.max(gear.runSpeedPct, buffs.runSpeedPct),
    mp5: sum("mp5") + passiveMp5,
    rangedWeapon,
    meleeAttackPower,
    mainHand: meleeWeapon("mainHand"),
    offHand: meleeWeapon("offHand"),
    gearNotes: worn.notes,
    weaponProcs: (items.get(config.gear.items.ranged ?? 0)?.procSpells ?? []).flatMap((id) => data.spells[String(id)] ?? []),
  };
}

// A talent's value for one effect at the rank taken, or 0 when not taken.
export function talentValue(data: HunterData, config: SimConfig, name: string, effectIndex: number): number {
  const rank = config.talents[name] ?? 0;
  if (rank === 0) return 0;
  const t = data.talents.find((x) => x.name === name)!;
  return resolveEffects(data.spells[String(t.spellId)]!, t, rank).find((e) => e.index === effectIndex)!.value;
}
