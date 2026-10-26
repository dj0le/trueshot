// Upstream data pinned to one client build, so every number traces back to a known version.
// Bump WOWF_BUILD deliberately and rerun `bun run fetch`; see https://wago.tools/api/builds (product "wowf").
export const WOWF_BUILD = "1.60.1.70532";

// Client DB2 tables the normalizer reads. wago.tools serves each as CSV.
export const DB2_TABLES = [
  // Spells
  "SpellName",
  "SpellEffect",
  "SpellMisc",
  "SpellLevels",
  "SpellPower",
  "SpellCooldowns",
  "SpellCategories",
  "SpellCategory",
  "SpellCastTimes",
  "SpellDuration",
  "SpellRange",
  "SpellAuraOptions",
  // The aura state a spell needs on its caster (Mongoose Bite after a dodge).
  "SpellAuraRestrictions",
  "SpellProcsPerMinute",
  "SpellClassOptions",
  "SpellItemEnchantment",
  "SkillLineAbility",
  // Talents. Forever keeps them in the trait system; Talent/TalentTab are stale Classic rows.
  "TraitTree",
  "TraitNode",
  "TraitNodeEntry",
  "TraitNodeXTraitNodeEntry",
  "TraitDefinition",
  "TraitDefinitionEffectPoints",
  "TraitEdge",
  "Curve",
  "CurvePoint",
  // Character and pets
  "ChrRaces",
  "ChrClasses",
  "CreatureFamily",
  // Items. Forever stores stat allocations, turned into amounts with RandPropPoints, and
  // weapon damage as DPS by item level in the ItemDamage tables.
  "Item",
  "ItemSparse",
  "ItemEffect",
  // Forever links items to their effects here; ItemEffect has no ParentItemID column, unlike Classic Era.
  "ItemXItemEffect",
  "RandPropPoints",
  "ItemDamageRanged",
  "ItemDamageThrown",
  "ItemDamageOneHand",
  "ItemDamageTwoHand",
  // Set bonuses: the items in each set, and the spells its piece counts turn on.
  "ItemSet",
  "ItemSetSpell",
] as const;

// Classic Era client: cross-checks the item formulas, and supplies stats for Forever items the
// client does not ship (the server sends those), on the assumption they are unchanged.
export const CLASSIC_ERA_BUILD = "1.15.9.70003";
export const CLASSIC_ERA_TABLES = ["ItemSparse", "ItemEffect"] as const;

// The one trait tree holding all three hunter talent trees, laid out side by side.
export const HUNTER_TRAIT_TREE_ID = "1091";

export const db2Url = (table: string, build = WOWF_BUILD) =>
  `https://wago.tools/db2/${table}/csv?build=${build}`;

// Talent trees, spellbook and tooltips from the beta client. CC BY 4.0, credit talentsforever.com.
export const TALENTSFOREVER_HUNTER_URL = "https://talentsforever.com/export/hunter.json";
