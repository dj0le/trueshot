// The client's enum values the engine implements. Anything the data uses that is not listed
// here is ignored, and `sim run` lists those so nothing goes missing silently.

export const Effect = {
  SchoolDamage: 2,
  Dummy: 3,
  ApplyAura: 6,
  Energize: 30,
  // Casts a linked spell on the caster at once (Jom Gabbar's first stack).
  TriggerSpell: 64,
  // A ground area with an aura on whoever stands in it (Explosive Trap's burn).
  PersistentAreaAura: 27,
  // Places an object (a trap); the server casts the linked spell when it springs.
  SummonObject: 104,
  ApplyAreaAuraParty: 35,
  WeaponPercentDamage: 31,
  WeaponDamage: 58,
  ApplyAreaAuraRaid: 65,
  NormalizedWeaponDamage: 121,
  // A run-up to the target (a pet's Charge).
  Charge: 96,
} as const;

export const Aura = {
  PeriodicDamage: 3,
  // Mana every few seconds: Blessing of Wisdom, Mana Spring.
  PeriodicEnergize: 24,
  Dummy: 4,
  ModStealth: 16,
  ProcTriggerSpell: 42,
  ModDamagePercentDone: 79,
  // Damage done to some creature types (Improved Tracking on a Track spell); the mask is in miscValue.
  ModDamageDoneVersusCreature: 168,
  ModAttackPower: 99,
  ModPowerRegenPercent: 110,
  AddFlatModifier: 107,
  AddPctModifier: 108,
  ModRangedAttackPower: 124,
  // Ranged attack power against some creature types; the mask is in miscValue.
  ModRangedAttackPowerVersus: 131,
  ModCritDamageBonus: 163,
  ModRangedAttackPowerPct: 167,
  // Melee attack power in percent (Blood Fury's melee half).
  ModAttackPowerPct: 166,
  // Off-hand damage in percent of itself (Predator's Edge).
  ModOffhandDamagePct: 122,
  RangedAttackPowerAttackerBonus: 127,
  ModManaRegenInterrupt: 134,
  ModTotalStatPercentage: 137,
  ModRangedHaste: 140,
  ModRangedAmmoHaste: 141,
  PeriodicDummy: 226,
  ModCritPct: 290,
  ModHitChance: 54,
  // Run speed in percent (Strider Kick); the highest one counts.
  ModIncreaseSpeed: 31,
  // Fires a linked spell every period (Jom Gabbar).
  PeriodicTriggerSpell: 23,
  // Lowers the target's resistance (armor, miscValue 1) to the hunter's own attacks (Badge of the
  // Swarmguard). The value is negative.
  ModTargetResistance: 123,
  // Flat primary stat; miscValue is the stat, -1 for all (set bonuses).
  ModStat: 29,
  // Mana per 5 sec (set bonuses); miscValue 0 is mana.
  ModPowerRegen: 85,
  // Melee haste: Rapid Fire's melee half, the pet's Frenzy and Trickster's Dance.
  ModMeleeHaste: 319,
  // Melee and ranged haste together (Wind Blessed).
  ModMeleeRangedHaste2: 342,
  // Careful Aim's two auras: attack power from a percentage of a stat. Which one is melee and
  // which is ranged is not documented; both carry the same value, so ranged reads 598.
  ModAttackPowerOfStatPercent: 580,
  ModRangedAttackPowerOfStatPercent: 598,
} as const;

// Present in spells the sim uses but with no effect on single-target ranged damage.
export const IGNORED_AURAS = new Set<number>([
  61, // Bestial Wrath: pet size
  22, // resistances (set bonuses)
  102, // melee attack power against creature types
  44, // Track spells: creatures on the minimap
  45, // Track Beasts: resources on the minimap
  68, // Hunter's Mark: makes the target visible
  77, // Bestial Wrath: pet immunities
  50, // Endurance, Earth Fury: critical healing
  65, // Berserking, Wind Blessed: spell haste
  133, // Endurance: max health
  120, // Aspect of the Beast: untrackable
  55, // spell hit (Surefooted)
  232, // movement impairing duration (Surefooted)
  317, // Blood Fury: spell power
]);
export const IGNORED_EFFECTS = new Set<number>([
  179, // Volley: creates the ground area; damage comes from the linked tick spell
  32, // Summon Hawk: the dive's missile; its damage is the spell's own damage effect
]);

// Implicit targets: the enemy (6, 25) and the hunter's pet (5). Anything else lands on the caster.
export const TARGET_ENEMY = new Set([6, 25]);
export const TARGET_PET = 5;
export const TARGET_CASTER = 1;
// The caster's party around it (Furious Howl).
export const TARGET_CASTER_PARTY = 56;

// Attributes_1 flags marking a channeled spell.
export const CHANNELED_FLAGS = 0x4 | 0x40;

// What an AddFlatModifier / AddPctModifier aura changes on the spells its class mask matches.
export const SpellModOp = {
  Damage: 0,
  Duration: 1,
  Effect1: 3,
  Range: 5,
  CritChance: 7,
  AllEffects: 8,
  CastTime: 10,
  Cooldown: 11,
  Effect2: 12,
  Cost: 14,
  CritDamageBonus: 15,
  // Less chance for the spell to miss (Survival Tactics on traps).
  ResistMissChance: 16,
  ProcChance: 18,
  PeriodicDamage: 22,
  Effect3: 23,
} as const;

// The modifier that changes one effect's value, by effect index.
export const EFFECT_VALUE_OPS = [SpellModOp.Effect1, SpellModOp.Effect2, SpellModOp.Effect3];

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
  TakenMeleeAutoAttack: 0x8,
  DoneMeleeSpell: 0x10,
  TakenMeleeSpell: 0x20,
  DoneRangedAutoAttack: 0x40,
  TakenRangedAutoAttack: 0x80,
  DoneRangedSpell: 0x100,
  TakenRangedSpell: 0x200,
} as const;

// Creature types as the client numbers them; a creature-type mask has bit (type - 1) set.
export const CreatureType = {
  beast: 1,
  dragonkin: 2,
  demon: 3,
  elemental: 4,
  giant: 5,
  undead: 6,
  humanoid: 7,
  critter: 8,
  mechanical: 9,
} as const;

export const Stat = { Strength: 0, Agility: 1, Stamina: 2, Intellect: 3, Spirit: 4 } as const;
