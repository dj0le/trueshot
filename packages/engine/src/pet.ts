// The hunter's pet: white swings, focus, an ability priority, and its own auras. Hunter talents
// reach it by modifying the shared pet passives (Unleashed Fury, Ferocity, Frenzy, Bestial
// Discipline), exactly as the client wires them.
import type { HunterData, Overrides, PetFamily, Spell } from "@trueshot/data";
import { AuraSet } from "./auras";
import type { AttackTable } from "./levels";
import { type ActiveSpell, knownRank, type ResolvedEffect, resolveEffects, snake } from "./character";
import { Aura, DefenseType, Effect, IGNORED_AURAS, ProcFlag, School, SpellModOp, TARGET_CASTER, TARGET_CASTER_PARTY } from "./enums";
import type { EventQueue } from "./queue";
import type { Rng } from "./rng";
import type { HunterStats } from "./stats";

// What the pet needs from the fight it is in.
export type PetHost = {
  readonly now: number;
  readonly queue: EventQueue;
  readonly rng: Rng;
  readonly attackPowerPerDps: number;
  // The hunter's numbers: spell modifiers (which reach pet passives), the attack power, crit and hit
  // the pet inherits, the target's armor without the hunter's own penetration, and Focused Fire.
  readonly calc: Pick<
    HunterStats,
    "modded" | "moddedEffects" | "ownRangedAttackPower" | "meleeAttackPower" | "sheetCritPct" | "hitPct" | "armorMultiplier" | "sharedDamagePct"
  >;
  // The part of the hunter's crit that comes from Agility, which crit suppression treats apart.
  readonly agilityCritPct: number;
  // The pet passives hawks share (Unleashed Fury, Ferocity), which the pet builds on.
  readonly hawkAuras: AuraSet;
  record(name: string, outcome: "hit" | "crit" | "miss" | "glance" | "tick" | "cast", amount?: number): void;
  report(what: string): void;
};

// Pet buffs that raise its damage.
const DAMAGE_BUFFS = new Set<number>([Aura.ModMeleeHaste, Aura.ModAttackPower, Aura.ModDamagePercentDone]);
// Buffs land on the pet itself (1) or its group around it (56, Furious Howl).
const BUFF_TARGETS = new Set([TARGET_CASTER, TARGET_CASTER_PARTY]);
// A pet ability's focus cost.
const focusCost = (s: Spell) => s.power.find((p) => p.type === 2)?.cost ?? 0;

const isBuff = (e: ResolvedEffect) => e.effect === Effect.ApplyAura && BUFF_TARGETS.has(e.implicitTarget[0]) && DAMAGE_BUFFS.has(e.aura) && e.value > 0;

// The pet abilities a family knows at a level, by snake_case name.
function knownAbilities(data: HunterData, family: PetFamily, level: number): Map<string, Spell> {
  const known = new Map<string, Spell>();
  for (const a of data.abilities) {
    if (a.tab !== "Pets" || !family.abilities.includes(a.name)) continue;
    const spell = knownRank(data, a, level);
    if (spell) known.set(snake(a.name), spell);
  }
  return known;
}

// A family's default autocast at a level, what pet.abilities falls back to.
export function defaultPetAbilities(data: HunterData, familyName: string, level: number): string[] {
  const family = data.petFamilies.find((f) => f.name === familyName);
  if (!family) throw new Error(`pet: unknown family "${familyName}"`);
  return defaultPriority(knownAbilities(data, family, level));
}

// The default autocast: every ability that deals damage or raises the pet's damage. Buffs first,
// then damage by cooldown, longest first, so the cheap filler (Claw) takes what is left. Openers
// that need stealth or a run-up (Prowl, Charge) stay off.
function defaultPriority(known: Map<string, Spell>): string[] {
  const kind = (s: Spell) => {
    const effects = resolveEffects(s);
    if (effects.some((e) => e.effect === Effect.Charge || e.aura === Aura.ModStealth)) return null;
    if (effects.some(isBuff)) return 0;
    const damage = effects.some((e) => e.effect === Effect.SchoolDamage || (e.effect === Effect.ApplyAura && e.aura === Aura.PeriodicDamage));
    return damage ? 1 : null;
  };
  const cooldown = (s: Spell) => Math.max(s.cooldownMs, s.categoryCooldownMs);
  return [...known]
    .map(([name, spell]) => ({ name, spell, kind: kind(spell) }))
    .filter((a) => a.kind !== null)
    .sort((a, b) => a.kind! - b.kind! || cooldown(b.spell) - cooldown(a.spell) || focusCost(b.spell) - focusCost(a.spell))
    .map((a) => a.name);
}

// Pet auras the sim reads, plus those with no effect on its damage (defensive, cosmetic or out of
// scope). Anything else is reported.
const KNOWN_PET_AURAS = new Set<number>([
  Aura.PeriodicDamage,
  Aura.ModMeleeHaste,
  Aura.ModAttackPower,
  Aura.ModDamagePercentDone,
  Aura.ProcTriggerSpell, // handled by the proc check
  ...IGNORED_AURAS,
  13, 22, 26, 29, 31, 33, 49, 67, 101, 118, 133, 142, 230, 563,
]);

export class Pet {
  private focus = 100;
  private focusAt = 0;
  private gcdReadyAt = 0;
  private readonly cooldowns = new Map<number, number>();
  private readonly auras: AuraSet;
  // The pet's DoTs on the target. Reapplying one replaces it.
  private readonly dots: AuraSet;
  private readonly abilities: Spell[];
  private readonly known: Map<string, Spell>;
  private wakeAt = -1;

  constructor(
    private host: PetHost,
    private data: HunterData,
    private o: Overrides["pet"],
    readonly family: PetFamily,
    // The pet's level, its creature weapon's DPS there, and its attack table against the target.
    private readonly stats: { level: number; creatureDps: number; table: AttackTable },
    priority: string[] | undefined,
    // When the pet stops attacking for the rest of the fight (pet.attackingPct).
    private readonly attackingUntil: number,
  ) {
    // Passive values settle once, with the hunter's talents applied through spell modifiers.
    const familySpell = data.spells[String(family.passiveSpellId)]!;
    const familyPassive: ActiveSpell = {
      spell: familySpell,
      effects: host.calc.moddedEffects(familySpell, resolveEffects(familySpell)),
      source: familySpell.name,
    };
    this.auras = new AuraSet(host.queue, [...host.hawkAuras.passives, familyPassive]);
    this.dots = new AuraSet(host.queue);

    const known = (this.known = knownAbilities(data, family, stats.level));
    const order = priority ?? defaultPriority(known);
    for (const name of priority ?? []) {
      if (!known.has(name)) throw new Error(`pet: a ${family.name} does not know "${name}" at level ${stats.level}`);
    }
    this.abilities = order.filter((n) => known.has(n)).map((n) => known.get(n)!);
  }

  start(): void {
    this.swing();
    this.act();
  }

  // Effects and stats ==========================================================

  // own: the pet itself; otherwise a hawk, which has only the auras hawks share.
  attackPower(own = true): number {
    const c = this.host.calc;
    const inherited = (Math.max(c.ownRangedAttackPower(), c.meleeAttackPower()) * this.o.inheritAttackPowerPct.value) / 100;
    const base = this.stats.creatureDps * this.o.attackPowerPerCreatureDps.value;
    return base + inherited + (own ? this.auras.sum(Aura.ModAttackPower) : 0);
  }

  // Melee and spell miss with the hunter's hit inherited.
  private missPct(): number {
    const t = this.stats.table;
    return Math.max(0, t.missPct - Math.max(0, this.host.calc.hitPct() - t.hitPenaltyPct));
  }

  private spellMissPct(): number {
    return Math.max(1, this.stats.table.spellMissPct - this.host.calc.hitPct() * this.o.spellHitPerHit.value);
  }

  // A hawk's hit is measured as a share of a happy pet's (pet.hawk), so happiness stays in; Focused
  // Fire ("you and your pet") does not reach hawks.
  private damageMultiplier(school: number, own = true): number {
    const happy = 1 + this.o.happinessDamagePct.value / 100;
    if (!own) return happy * this.host.hawkAuras.damageMultiplier(school);
    return happy * (1 + this.host.calc.sharedDamagePct() / 100) * this.auras.damageMultiplier(school);
  }

  // The hunter's sheet crit plus the pet's own crit auras (Ferocity), less the target's suppression,
  // which takes extra off crit that is not from Agility. Pets have no crit of their own.
  private critPct(own: boolean): number {
    const total = this.host.calc.sheetCritPct() + (own ? this.auras : this.host.hawkAuras).sum(Aura.ModCritPct);
    const auraCrit = Math.max(0, total - this.host.agilityCritPct);
    const t = this.stats.table;
    return Math.max(0, total - t.critSuppressionPct - Math.min(auraCrit, t.auraCritSuppressionPct));
  }

  private focusNow(): number {
    return Math.min(100, this.focus + this.focusRate() * (this.host.now - this.focusAt));
  }

  // Focus per millisecond.
  private focusRate(): number {
    return (this.o.focusPerSecond.value * (1 + this.auras.sum(Aura.ModPowerRegenPercent, 2) / 100)) / 1000;
  }

  // White swings ===============================================================

  private swing(): void {
    if (!this.attacking()) return;
    this.whiteHit("Pet: Melee", "pet", 1, true);
    const speed = this.o.attackSpeedSec.value;
    this.host.queue.push(this.host.now + (speed * 1000) / this.auras.product([Aura.ModMeleeHaste]), () => this.swing());
  }

  // One white melee hit on the one-roll table (miss, dodge, glance, crit, hit), at `scale` times
  // the pet's own damage. Only the pet's own hits spend charges and set off its crit procs.
  private whiteHit(name: string, streams: string, scale: number, own: boolean): void {
    const rng = this.host.rng.stream(`${streams}-auto`).next() * 100;
    const t = this.stats.table;
    const dodge = this.missPct() + t.dodgePct;
    const glance = dodge + t.glancingPct;
    const crit = glance + this.critPct(own);
    if (rng < dodge) {
      this.host.record(name, "miss");
      return;
    }
    if (own) this.auras.consumeCharges(ProcFlag.DoneMeleeAutoAttack);
    // A creature's weapon of the pet's level over 2.0 sec, plus attack power, scaled to the swing.
    const spread = this.o.swingSpreadPct.value / 100;
    const weapon = 2 * this.stats.creatureDps * this.host.rng.stream(`${streams}-damage`).range(1 - spread, 1 + spread);
    const speed = this.o.attackSpeedSec.value;
    let amount =
      (weapon + (this.attackPower(own) / 14) * 2) *
      (speed / 2) *
      this.damageMultiplier(School.Physical, own) *
      this.host.calc.armorMultiplier() *
      scale;
    if (rng < glance) {
      amount *= 1 - t.glancingPenaltyPct / 100;
      this.host.record(name, "glance", amount);
    } else if (rng < crit) {
      this.host.record(name, "crit", amount * 2);
      if (own) this.onCrit();
    } else {
      this.host.record(name, "hit", amount);
    }
  }

  // Hawks =======================================================================
  // Summon Hawk leaves a hawk attacking the target. Its attack is server-side, so its size and speed
  // are overrides (pet.hawk), taken as a share of the pet's white hit so pet talents carry over.

  private hawks: { expiresAt: number }[] = [];

  // The hawk flies in before its time starts.
  summonHawk(): void {
    this.host.queue.push(this.host.now + this.o.hawk.arrivalSec.value * 1000, () => this.hawkArrives());
  }

  private hawkArrives(): void {
    const h = this.o.hawk;
    // A new hawk past the limit replaces the oldest.
    if (this.hawks.length >= h.maxActive.value) this.hawks.shift();
    const hawk = { expiresAt: this.host.now + h.durationSec.value * 1000 };
    this.hawks.push(hawk);
    const live = () => this.hawks.includes(hawk);
    const interval = h.attackIntervalSec.value * 1000;
    for (let t = this.host.now + interval; t <= hawk.expiresAt; t += interval) {
      this.host.queue.push(t, () => {
        if (live()) this.whiteHit("Hawk: Attack", "hawk", h.hitPctOfPetMelee.value / 100, false);
      });
    }
    // Scheduled after the attacks, so one landing exactly on expiry still happens.
    this.host.queue.push(hawk.expiresAt, () => {
      this.hawks = this.hawks.filter((x) => x !== hawk);
    });
  }

  activeHawks(): number {
    return this.hawks.length;
  }

  // Time until the next hawk leaves, 0 with none out.
  hawkMinRemainsMs(): number {
    return this.hawks.length ? Math.min(...this.hawks.map((x) => x.expiresAt)) - this.host.now : 0;
  }

  // Frenzy and anything like it: the client marks no "on crit" flag, the tooltips do.
  private onCrit(): void {
    for (const p of this.auras.passives) {
      const proc = p.spell.proc;
      if (!proc) continue;
      for (const e of p.effects) {
        if (e.aura !== Aura.ProcTriggerSpell || !e.triggerSpell) continue;
        const chance = this.host.calc.modded(proc.chance, p.spell, SpellModOp.ProcChance);
        if (!this.host.rng.stream(`pet-proc:${p.spell.id}`).chance(chance)) continue;
        const triggered = this.data.spells[String(e.triggerSpell)]!;
        this.addAura(triggered, resolveEffects(triggered), triggered.durationMs);
      }
    }
  }

  // Abilities ==================================================================

  knows(name: string): boolean {
    return this.known.has(name);
  }

  // An ability sent from the hunter's macro. It goes out now if the pet can, or not at all.
  command(name: string): void {
    const spell = this.known.get(name)!;
    if (this.attacking() && this.host.now >= this.gcdReadyAt && this.tryUse(spell) === 0) this.wake(this.gcdReadyAt);
  }

  // Autocast: the first ability in priority order that is off cooldown and affordable.
  private attacking(): boolean {
    return this.host.now < this.attackingUntil;
  }

  private act(): void {
    if (!this.attacking()) return;
    const now = this.host.now;
    if (now < this.gcdReadyAt) return this.wake(this.gcdReadyAt);

    let next = Infinity;
    for (const spell of this.abilities) {
      const at = this.tryUse(spell);
      if (at === 0) return this.wake(this.gcdReadyAt);
      next = Math.min(next, at);
    }
    if (next !== Infinity) this.wake(next);
  }

  // Uses the ability and returns 0, or returns when its cooldown or focus would allow it.
  private tryUse(spell: Spell): number {
    const now = this.host.now;
    const ready = this.cooldowns.get(spell.id) ?? 0;
    if (ready > now) return ready;
    const cost = focusCost(spell);
    const focus = this.focusNow();
    if (focus < cost) return now + Math.ceil((cost - focus) / this.focusRate());
    this.focus = focus - cost;
    this.focusAt = now;
    this.use(spell);
    this.gcdReadyAt = now + spell.gcdMs;
    const cd = Math.max(spell.cooldownMs, spell.categoryCooldownMs);
    if (cd > 0) this.cooldowns.set(spell.id, now + cd);
    return 0;
  }

  private wake(at: number): void {
    if (this.wakeAt > this.host.now && this.wakeAt <= at) return;
    this.wakeAt = at;
    this.host.queue.push(at, () => this.act());
  }

  private use(spell: Spell): void {
    const name = `Pet: ${spell.name}`;
    this.host.record(name, "cast");
    const effects = resolveEffects(spell);
    const damaging = effects.filter((e) => e.effect === Effect.SchoolDamage);
    const auraEffects = effects.filter((e) => e.effect === Effect.ApplyAura);

    if (spell.defenseType !== DefenseType.None) {
      const r = this.host.rng.stream("pet-special").next() * 100;
      const t = this.stats.table;
      const avoid =
        spell.defenseType === DefenseType.Magic ? this.spellMissPct() : this.missPct() + (spell.defenseType === DefenseType.Melee ? t.dodgePct : 0);
      if (r < avoid) {
        this.host.record(name, "miss");
        return;
      }
    }

    if (damaging.length > 0) {
      let amount = 0;
      for (const e of damaging) {
        amount += e.value * (1 + this.host.rng.stream("pet-damage").range(-e.variance / 2, e.variance / 2));
      }
      amount *= this.damageMultiplier(spell.school);
      if (spell.school === School.Physical) amount *= this.host.calc.armorMultiplier();
      if (this.host.rng.stream("pet-special-crit").chance(this.critPct(true))) {
        this.host.record(name, "crit", amount * 2);
        this.onCrit();
      } else {
        this.host.record(name, "hit", amount);
      }
    } else {
      // An ability that lands without direct damage (Web) still hits; its ticks come later.
      this.host.record(name, "hit");
    }
    // After the crit roll, which the charge applied to.
    if (spell.defenseType === DefenseType.Melee) this.auras.consumeCharges(ProcFlag.DoneMeleeSpell);

    for (const e of auraEffects) {
      if (!KNOWN_PET_AURAS.has(e.aura)) this.host.report(`${name} (${spell.id}): aura ${e.aura}`);
    }
    const dots = auraEffects.filter((e) => e.aura === Aura.PeriodicDamage);
    if (dots.length > 0) {
      this.dots.add(spell, dots, this.host.now, spell.durationMs, (isLive) => {
        for (const e of dots) {
          const tick = e.value * this.damageMultiplier(spell.school);
          for (let t = e.periodMs; t <= spell.durationMs; t += e.periodMs) {
            this.host.queue.push(this.host.now + t, () => {
              if (isLive()) this.host.record(name, "tick", tick);
            });
          }
        }
      });
    }
    // Buffs on the pet itself (Trickster's Dance, Furious Howl), not debuffs around it (Demoralizing Screech).
    const buffs = auraEffects.filter((e) => e.aura !== Aura.PeriodicDamage && BUFF_TARGETS.has(e.implicitTarget[0]));
    if (buffs.length > 0) this.addAura(spell, buffs, spell.durationMs);
  }

  // Auras ======================================================================

  // A duration below zero, as the client stores "until cancelled", lasts the whole fight.
  addAura(spell: Spell, effects: ResolvedEffect[], durationMs: number): void {
    this.auras.add(spell, effects, this.host.now, durationMs < 0 ? Infinity : durationMs);
  }
}
