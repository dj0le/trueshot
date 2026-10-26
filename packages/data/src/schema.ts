// Shape of packages/data/generated/hunter.json, the one file the engine reads.
// Enum-like numbers (effect, aura, school, power type) are kept as the client stores them;
// the engine names the ones it implements.

export type SpellEffect = {
  index: number;
  effect: number;
  aura: number;
  basePoints: number;
  variance: number;
  pointsPerLevel: number;
  apCoefficient: number;
  spCoefficient: number;
  periodMs: number;
  triggerSpell: number;
  chainTargets: number;
  mechanic: number;
  miscValue: [number, number];
  radiusIndex: [number, number];
  implicitTarget: [number, number];
  // Which spells an aura modifies, matched against the target spell's classOptions.mask.
  classMask: [number, number, number, number];
};

export type SpellPower = { type: number; cost: number; costPct: number; costPerLevel: number };

export type SpellProc = {
  chance: number;
  charges: number;
  ppm: number;
  categoryRecoveryMs: number;
  typeMask: [number, number];
  cumulative: number;
};

export type Spell = {
  id: number;
  name: string;
  school: number;
  attributes: number[];
  castTimeMs: number;
  durationMs: number;
  maxDurationMs: number;
  rangeMin: number;
  rangeMax: number;
  speed: number;
  baseLevel: number;
  spellLevel: number;
  maxLevel: number;
  cooldownMs: number;
  categoryCooldownMs: number;
  gcdMs: number;
  category: number;
  gcdCategory: number;
  defenseType: number;
  preventionType: number;
  mechanic: number;
  dispelType: number;
  power: SpellPower[];
  proc: SpellProc | null;
  classOptions: { set: number; mask: [number, number, number, number] } | null;
  effects: SpellEffect[];
};

export type AbilityRank = { rank: number | null; spellId: number; level: number };

export type Ability = { name: string; tab: string; ranks: AbilityRank[] };

// values[r - 1] is the effect's base points with r ranks taken.
export type TalentRankEffect = { effectIndex: number; operation: number; values: number[] };

export type Talent = {
  name: string;
  tree: string;
  row: number;
  col: number;
  maxRank: number;
  // false when the talent teaches an ability (Trueshot Aura, Sniper Shot) rather than a passive effect.
  passive: boolean;
  spellId: number;
  rankEffects: TalentRankEffect[];
  requires: string[];
  text: string[];
  classicStatus: string | null;
};

export type PetFamily = {
  id: number;
  name: string;
  petFoodMask: number;
  petTalentType: number;
  skillLines: number[];
  // The family's "Tamed Pet Passive": physical damage, armor and health percentages.
  passiveSpellId: number;
  // Pet-tab abilities this family can learn, by name.
  abilities: string[];
};

// A usable item: its spell, and the item cooldown it shares with others of its category.
export type Consumable = { itemId: number; name: string; spellId: number; categoryId: number; cooldownMs: number };

// A racial ability of one race (as talentsforever names it, "Skyborne (Windshaper)"). Active ones are
// cast from the rotation; passive ones are always on.
export type Racial = { race: string; name: string; spellId: number; active: boolean };

export type HunterData = {
  build: string;
  sources: { name: string; url: string; license?: string }[];
  spells: Record<string, Spell>;
  abilities: Ability[];
  talents: Talent[];
  petFamilies: PetFamily[];
  // Passives every hunter pet has. Hunter talents reach the pet by modifying these
  // (Unleashed Fury, Ferocity, Frenzy, Bestial Discipline).
  petPassives: number[];
  consumables: Consumable[];
  racials: Racial[];
  // Sets with a piece a hunter can wear. Their bonus spells are in `spells`.
  itemSets: ItemSet[];
};

export type ItemStats = Partial<
  Record<
    | "strength"
    | "agility"
    | "stamina"
    | "intellect"
    | "spirit"
    | "attackPower"
    | "rangedAttackPower"
    | "hitRating"
    | "critRating"
    | "hitPct"
    | "critPct"
    | "mp5"
    | "spellDamage"
    | "healing"
    | "hastePct",
    number
  >
>;

// A set of items, and the spell each piece count turns on.
export type ItemSet = { id: number; name: string; items: number[]; bonuses: { threshold: number; spellId: number }[] };

// One entry of generated/enchants.json. weaponDamage is a scope's flat damage per shot. unparsed:
// parts the build could not turn into stats (procs, threat, odd auras).
export type Enchant = { id: number; name: string; stats: ItemStats; weaponDamage: number; unparsed: string[] };

// One entry of generated/items.json.
export type Item = {
  id: number;
  name: string;
  // forever: computed from the Forever client. classic: the client does not ship it, so these are
  // its Classic Era values, assumed unchanged.
  source: "forever" | "classic";
  quality: number;
  itemLevel: number;
  requiredLevel: number;
  inventoryType: number;
  classId: number;
  subclassId: number;
  stats: ItemStats;
  weapon?: { kind: "ranged" | "thrown" | "oneHand" | "twoHand"; min: number; max: number; speed: number };
  // On-equip spells (already folded into stats where they are plain stat bonuses) and chance-on-hit spells.
  equipSpells: number[];
  procSpells: number[];
  // Equip spells that are not plain stats (procs, odd auras): the engine runs them as passives.
  passiveSpells: number[];
  // On-use effects (trinkets): the spell, the item's own cooldown, and the lockout it shares with
  // others of its category (20 sec between trinkets).
  useSpells: { spellId: number; cooldownMs: number; categoryId: number; categoryCooldownMs: number }[];
  // Stat types and equip spells the build could not turn into stats.
  unparsedStats: number[];
  unparsedEquip: string[];
};
