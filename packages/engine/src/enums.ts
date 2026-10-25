// The client's enum values the engine implements. Anything the data uses that is not listed
// here is ignored, and `sim run` lists those so nothing goes missing silently.

export const Effect = {
  SchoolDamage: 2,
  Dummy: 3,
  ApplyAura: 6,
  WeaponPercentDamage: 31,
  WeaponDamage: 58,
  ApplyAreaAuraRaid: 65,
  NormalizedWeaponDamage: 121,
} as const;

export const Aura = {
  PeriodicDamage: 3,
  Dummy: 4,
  ProcTriggerSpell: 42,
  ModDamagePercentDone: 79,
  ModAttackPower: 99,
  ModPowerRegenPercent: 110,
  AddFlatModifier: 107,
  AddPctModifier: 108,
  ModRangedAttackPower: 124,
  RangedAttackPowerAttackerBonus: 127,
  ModManaRegenInterrupt: 134,
  ModTotalStatPercentage: 137,
  ModRangedHaste: 140,
  ModRangedAmmoHaste: 141,
  PeriodicDummy: 226,
  ModCritPct: 290,
  // Melee haste: Rapid Fire's melee half, the pet's Frenzy and Trickster's Dance.
  ModMeleeHaste: 319,
  // Careful Aim's two auras: attack power from a percentage of a stat. Which one is melee and
  // which is ranged is not documented; both carry the same value, so ranged reads 598.
  ModAttackPowerOfStatPercent: 580,
  ModRangedAttackPowerOfStatPercent: 598,
} as const;

// Present in spells the sim uses but with no effect on single-target ranged damage.
export const IGNORED_AURAS = new Set<number>([
  61, // Bestial Wrath: pet size
  68, // Hunter's Mark: makes the target visible
  77, // Bestial Wrath: pet immunities
]);
export const IGNORED_EFFECTS = new Set<number>([
  179, // Volley: creates the ground area; damage comes from the linked tick spell
]);

// Attributes_1 flags marking a channeled spell.
export const CHANNELED_FLAGS = 0x4 | 0x40;

// What an AddFlatModifier / AddPctModifier aura changes on the spells its class mask matches.
export const SpellModOp = {
  Damage: 0,
  Duration: 1,
  Effect1: 3,
  Range: 5,
  CritChance: 7,
  CastTime: 10,
  Cooldown: 11,
  Cost: 14,
  CritDamageBonus: 15,
  ProcChance: 18,
  PeriodicDamage: 22,
} as const;

export const DefenseType = { None: 0, Magic: 1, Melee: 2, Ranged: 3 } as const;

export const School = {
  Physical: 1,
  Holy: 2,
  Fire: 4,
  Nature: 8,
  Frost: 16,
  Shadow: 32,
  Arcane: 64,
} as const;

// Classic proc flags, the events an aura's proc typeMask listens for.
export const ProcFlag = {
  DoneMeleeAutoAttack: 0x4,
  DoneMeleeSpell: 0x10,
  DoneRangedAutoAttack: 0x40,
  DoneRangedSpell: 0x100,
} as const;

export const Stat = { Strength: 0, Agility: 1, Stamina: 2, Intellect: 3, Spirit: 4 } as const;
