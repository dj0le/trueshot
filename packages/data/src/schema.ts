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
  damagePct: number;
  armorPct: number;
  healthPct: number;
  // Pet-tab abilities this family can learn, by name.
  abilities: string[];
};

export type SpellCategory = {
  id: number;
  name: string;
  flags: number;
  maxCharges: number;
  chargeRecoveryMs: number;
};

export type HunterData = {
  build: string;
  sources: { name: string; url: string; license?: string }[];
  spells: Record<string, Spell>;
  categories: Record<string, SpellCategory>;
  abilities: Ability[];
  talents: Talent[];
  petFamilies: PetFamily[];
  // Passives every hunter pet has. Hunter talents reach the pet by modifying these
  // (Unleashed Fury, Ferocity, Frenzy, Bestial Discipline).
  petPassives: number[];
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
    | "healing",
    number
  >
>;

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
  // Stat types and equip spells the build could not turn into stats.
  unparsedStats: number[];
  unparsedEquip: string[];
};
