// The hunter's numbers in combat: attack power, haste, hit and crit, spell modifiers, costs and the
// target's armor. They read the auras as they stand and keep no fight state of their own.
import type { GameData, Spell } from "@hunter-sim/data";
import type { AuraSet } from "./auras";
import type { Character, ResolvedEffect } from "./character";
import { Aura, DefenseType, EFFECT_VALUE_OPS, School, SpellModOp } from "./enums";
import type { AttackTable } from "./levels";

export type Target = { level: number; armor: number; table: AttackTable; creatureMask: number };

export class HunterStats {
  // Spell modifier sums, rebuilt only when a self aura carrying a spell modifier comes or goes.
  private readonly modsCache = new Map<number, { flat: number; pct: number }>();

  constructor(
    private readonly ch: Character,
    private readonly game: GameData,
    private readonly selfAuras: AuraSet,
    private readonly targetAuras: AuraSet,
    private readonly target: Target,
  ) {}

  // A self aura came or went; modifier sums are stale if it carried spell modifiers.
  aurasChanged(effects: readonly ResolvedEffect[]): void {
    if (effects.some((e) => e.aura === Aura.AddFlatModifier || e.aura === Aura.AddPctModifier)) this.modsCache.clear();
  }

  // The hunter's own ranged AP, which the pet inherits from.
  ownRangedAttackPower(): number {
    return this.attackPower(this.ch.rangedAttackPower, Aura.ModRangedAttackPower, Aura.ModRangedAttackPowerOfStatPercent, Aura.ModRangedAttackPowerPct);
  }

  // Attack power from the character, flat auras and a share of intellect, then percent auras.
  private attackPower(base: number, flatAura: number, ofIntellectAura: number, pctAura: number): number {
    const fromInt = (this.selfAuras.sum(ofIntellectAura) / 100) * this.ch.primary.intellect;
    return (base + this.selfAuras.sum(flatAura) + fromInt) * this.selfAuras.product([pctAura]);
  }

  // The target's bonus to ranged attackers (Hunter's Mark) and attack power against the target's
  // creature type (Seal of the Dawn) are added after the hunter's percent modifiers and only to the
  // hunter's own shots.
  rangedAttackPower(): number {
    let versus = 0;
    for (const e of this.selfAuras.effects()) {
      if (e.aura === Aura.ModRangedAttackPowerVersus && (e.miscValue[0] & this.target.creatureMask) !== 0) versus += e.value;
    }
    return this.ownRangedAttackPower() + versus + this.targetAuras.sum(Aura.RangedAttackPowerAttackerBonus);
  }

  meleeAttackPower(): number {
    return this.attackPower(this.ch.meleeAttackPower, Aura.ModAttackPower, Aura.ModAttackPowerOfStatPercent, Aura.ModAttackPowerPct);
  }

  meleeHaste(): number {
    return this.selfAuras.product([Aura.ModMeleeHaste, Aura.ModMeleeRangedHaste2]);
  }

  rangedHaste(): number {
    const base = (1 + this.ch.config.gear.quiverHastePct / 100) * (1 + this.ch.hastePct / 100);
    return this.selfAuras.product([Aura.ModRangedHaste, Aura.ModRangedAmmoHaste, Aura.ModMeleeRangedHaste2], base);
  }

  // Sum of AddFlatModifier and AddPctModifier values for one spell and one modifier kind.
  mods(spell: Spell, op: number): { flat: number; pct: number } {
    const key = spell.id * 32 + op;
    const cached = this.modsCache.get(key);
    if (cached) return cached;
    const opts = spell.classOptions;
    let flat = 0;
    let pct = 0;
    if (opts) {
      // Mask bits mean different spells in each class's family, so a modifier only reaches its own.
      for (const src of this.selfAuras.sources()) {
        if (src.spell.classOptions?.set !== opts.set) continue;
        for (const e of src.effects) {
          if (e.aura !== Aura.AddFlatModifier && e.aura !== Aura.AddPctModifier) continue;
          if (e.miscValue[0] !== op) continue;
          if (!e.classMask.some((m, i) => (m & opts.mask[i]!) !== 0)) continue;
          if (e.aura === Aura.AddFlatModifier) flat += e.value;
          else pct += e.value;
        }
      }
    }
    const out = { flat, pct };
    this.modsCache.set(key, out);
    return out;
  }

  sharedDamagePct(): number {
    const ff = this.ch.passives.find((p) => p.source === "Focused Fire");
    return ff ? ff.effects.reduce((s, e) => s + (e.aura === Aura.ModDamagePercentDone ? e.value : 0), 0) : 0;
  }

  // The hunter's damage-done auras for a school against this target.
  damageDone(school: number): number {
    return this.selfAuras.damageMultiplier(school, this.target.creatureMask);
  }

  modded(base: number, spell: Spell, op: number): number {
    const { flat, pct } = this.mods(spell, op);
    return (base + flat) * (1 + pct / 100);
  }

  // Effect values with the hunter's effect modifiers applied (Bestial Discipline on the pet's
  // focus regen, Improved Aspect of the Monkey).
  moddedEffects(spell: Spell, effects: ResolvedEffect[]): ResolvedEffect[] {
    return effects.map((e) => {
      const op = EFFECT_VALUE_OPS[e.index];
      const value = this.modded(op === undefined ? e.value : this.modded(e.value, spell, op), spell, SpellModOp.AllEffects);
      return value === e.value ? e : { ...e, value };
    });
  }

  // The target's armor as a damage multiplier, after debuffs others keep on it. The pet's and hawks'
  // hits take it as is; the hunter's own also take the hunter's armor penetration.
  armorMultiplier(penetration = 0): number {
    const f = this.game.overrides.formula;
    const armor = Math.max(0, this.target.armor - this.ch.config.target.armorReduction + penetration);
    const k = f.armorConstantBase.value + f.armorConstantPerLevel.value * this.ch.level;
    return 1 - armor / (armor + k);
  }

  // Armor penetration on the hunter is a negative target resistance (Badge of the Swarmguard).
  ownArmorMultiplier(): number {
    return this.armorMultiplier(this.selfAuras.sum(Aura.ModTargetResistance, School.Physical));
  }

  manaCost(spell: Spell): number {
    const p = spell.power.find((x) => x.type === 0);
    if (!p) return 0;
    const base = p.cost + (p.costPct / 100) * this.ch.baseMana;
    return Math.max(0, Math.floor(this.modded(base, spell, SpellModOp.Cost)));
  }

  castTime(spell: Spell): number {
    const base = Math.max(0, this.modded(spell.castTimeMs, spell, SpellModOp.CastTime));
    const hasted =
      spell.defenseType === DefenseType.Ranged && this.game.overrides.formula.rangedHasteAffectsCastTime.value === 1;
    return hasted ? base / this.rangedHaste() : base;
  }

  runSpeed(): number {
    let pct = this.ch.runSpeedPct;
    for (const e of this.selfAuras.effects()) if (e.aura === Aura.ModIncreaseSpeed) pct = Math.max(pct, e.value);
    return this.game.overrides.formula.runSpeedYdPerSec.value * (1 + pct / 100);
  }

  // Hit from gear, talents and buffs.
  hitPct(): number {
    return this.ch.hitPct + this.selfAuras.sum(Aura.ModHitChance);
  }

  missPct(): number {
    const t = this.target.table;
    return Math.max(0, t.missPct - Math.max(0, this.hitPct() - t.hitPenaltyPct));
  }

  // Crit as the character sheet shows it, before the target takes any off; the pet inherits it.
  sheetCritPct(): number {
    return this.ch.critPct + this.selfAuras.sum(Aura.ModCritPct);
  }

  // Crit chance after the target's suppression; a spell adds its own crit modifiers.
  critPct(spell: Spell | null, extraCritPct = 0): number {
    const t = this.target.table;
    const own = spell ? this.mods(spell, SpellModOp.CritChance).flat : 0;
    const total = this.ch.critPct + this.selfAuras.sum(Aura.ModCritPct) + own + extraCritPct;
    const auraCrit = total - this.ch.agilityCritPct;
    return Math.max(0, total - t.critSuppressionPct - Math.min(Math.max(0, auraCrit), t.auraCritSuppressionPct));
  }

  // Endurance and Earth Fury: "critical strike bonus to damage increased by 2%", read as 2% more
  // total critical damage, as the same aura worked on TBC's meta gems. A spell adds its own modifiers.
  critMultiplier(spell: Spell | null): number {
    const bonus = this.game.overrides.formula.critDamageBonusPct.value / 100;
    const own = spell ? this.mods(spell, SpellModOp.CritDamageBonus).pct / 100 : 0;
    return (1 + bonus * (1 + own)) * this.selfAuras.product([Aura.ModCritDamageBonus]);
  }

  attackPowerFor(spell: Spell): number {
    return spell.defenseType === DefenseType.Melee ? this.meleeAttackPower() : this.rangedAttackPower();
  }
}
