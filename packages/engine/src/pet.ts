// The hunter's pet: white swings, focus, an ability priority, and its own auras. Hunter talents
// reach it by modifying the shared pet passives (Unleashed Fury, Ferocity, Frenzy, Bestial
// Discipline), exactly as the client wires them.
import type { HunterData, Overrides, PetFamily, Spell } from "@hunter-sim/data";
import { AuraSet } from "./auras";
import { type ActiveSpell, knownRank, type ResolvedEffect, resolveEffects, snake } from "./character";
import { Aura, DefenseType, Effect, IGNORED_AURAS, ProcFlag, School, SpellModOp, TARGET_ENEMY } from "./enums";
import type { EventQueue } from "./queue";
import type { Rng } from "./rng";

// What the pet needs from the fight it is in.
export type PetHost = {
  readonly now: number;
  readonly queue: EventQueue;
  readonly rng: Rng;
  readonly attackPowerPerDps: number;
  // A value with the hunter's spell modifiers applied.
  modded(base: number, spell: Spell, op: number): number;
  moddedEffects(spell: Spell, effects: ResolvedEffect[]): ResolvedEffect[];
  ownRangedAttackPower(): number;
  armorMultiplier(): number;
  // Damage-done bonuses the pet shares with the hunter (Focused Fire).
  sharedDamagePct(): number;
  record(name: string, outcome: "hit" | "crit" | "miss" | "glance" | "tick" | "cast", amount?: number): void;
  report(what: string): void;
};

// Default ability priority, filtered to what the family knows. Buffs first, then damage.
const DEFAULT_PRIORITY = [
  "tricksters_dance",
  "furious_howl",
  "savage_rend",
  "dismember",
  "bite",
  "lightning_breath",
  "claw",
];

// Pet auras the sim reads, plus those with no effect on its damage (defensive, cosmetic or out of
// scope). Anything else is reported.
const KNOWN_PET_AURAS = new Set<number>([
  Aura.PeriodicDamage,
  Aura.ModMeleeHaste,
  Aura.ModAttackPower,
  Aura.ModDamagePercentDone,
  Aura.ProcTriggerSpell, // handled by the proc check
  ...IGNORED_AURAS,
  13, 22, 29, 31, 49, 101, 118, 133, 142, 230, 563,
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
  private readonly known = new Map<string, Spell>();
  private wakeAt = -1;

  constructor(
    private host: PetHost,
    private data: HunterData,
    private o: Overrides["pet"],
    readonly family: PetFamily,
    level: number,
    priority: string[] | undefined,
    // When the pet stops attacking for the rest of the fight (pet.attackingPct).
    private readonly attackingUntil: number,
  ) {
    // Passive values settle once, with the hunter's talents applied through spell modifiers.
    const passives: ActiveSpell[] = [...data.petPassives, family.passiveSpellId].map((id) => {
      const spell = data.spells[String(id)]!;
      return { spell, effects: host.moddedEffects(spell, resolveEffects(spell)), source: spell.name };
    });
    this.auras = new AuraSet(host.queue, passives);
    this.dots = new AuraSet(host.queue);

    const known = this.known;
    for (const a of data.abilities) {
      if (a.tab !== "Pets" || !family.abilities.includes(a.name)) continue;
      const spell = knownRank(data, a, level);
      if (spell) known.set(snake(a.name), spell);
    }
    const order = priority ?? DEFAULT_PRIORITY;
    for (const name of priority ?? []) {
      if (!known.has(name)) throw new Error(`pet: a ${family.name} does not know "${name}" at level ${level}`);
    }
    this.abilities = order.filter((n) => known.has(n)).map((n) => known.get(n)!);
  }

  start(): void {
    this.swing();
    this.act();
  }

  // Effects and stats ==========================================================

  attackPower(): number {
    return this.o.baseAttackPower.value + (this.host.ownRangedAttackPower() * this.o.inheritRangedAttackPowerPct.value) / 100 + this.auras.sum(Aura.ModAttackPower);
  }

  private damageMultiplier(school: number): number {
    const shared = (1 + this.o.happinessDamagePct.value / 100) * (1 + this.host.sharedDamagePct() / 100);
    return shared * this.auras.damageMultiplier(school);
  }

  // Crit buffs with charges (Intimidation) are spent by the pet's own next hit; hawks do not share them.
  private critPct(own: boolean): number {
    const auraCrit = this.auras.sum(Aura.ModCritPct) - (own ? 0 : this.auras.chargedSum(Aura.ModCritPct));
    return this.o.baseCritPct.value + auraCrit;
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
    const dodge = this.o.missPct.value + this.o.dodgePct.value;
    const glance = dodge + this.o.glancingPct.value;
    const crit = glance + this.critPct(own);
    if (rng < dodge) {
      this.host.record(name, "miss");
      return;
    }
    if (own) this.auras.consumeCharges(ProcFlag.DoneMeleeAutoAttack);
    const speed = this.o.attackSpeedSec.value;
    const base = this.host.rng.stream(`${streams}-damage`).range(this.o.baseDamage.min, this.o.baseDamage.max);
    let amount =
      (base + (this.attackPower() / this.host.attackPowerPerDps) * speed) *
      this.damageMultiplier(School.Physical) *
      this.host.armorMultiplier() *
      scale;
    if (rng < glance) {
      amount *= 1 - this.o.glancingPenaltyPct.value / 100;
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
        const chance = this.host.modded(proc.chance, p.spell, SpellModOp.ProcChance);
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
    const cost = spell.power.find((p) => p.type === 2)?.cost ?? 0;
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
      const avoid = this.o.missPct.value + (spell.defenseType === DefenseType.Melee ? this.o.dodgePct.value : 0);
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
      if (spell.school === School.Physical) amount *= this.host.armorMultiplier();
      if (this.host.rng.stream("pet-special-crit").chance(this.critPct(true))) {
        this.host.record(name, "crit", amount * 2);
        this.onCrit();
      } else {
        this.host.record(name, "hit", amount);
      }
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
    // Buffs on the pet itself (Trickster's Dance, Furious Howl).
    const buffs = auraEffects.filter((e) => e.aura !== Aura.PeriodicDamage && !TARGET_ENEMY.has(e.implicitTarget[0]));
    if (buffs.length > 0) this.addAura(spell, buffs, spell.durationMs);
  }

  // Auras ======================================================================

  // A duration below zero, as the client stores "until cancelled", lasts the whole fight.
  addAura(spell: Spell, effects: ResolvedEffect[], durationMs: number): void {
    this.auras.add(spell, effects, this.host.now, durationMs < 0 ? Infinity : durationMs);
  }
}
