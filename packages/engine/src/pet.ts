// The hunter's pet: white swings, focus, an ability priority, and its own auras. Hunter talents
// reach it by modifying the shared pet passives (Unleashed Fury, Ferocity, Frenzy, Bestial
// Discipline), exactly as the client wires them.
import type { HunterData, Overrides, PetFamily, Spell } from "@hunter-sim/data";
import { type ResolvedEffect, resolveEffects, snake } from "./character";
import { Aura, DefenseType, Effect, School, SpellModOp } from "./enums";
import type { EventQueue } from "./queue";
import type { Rng } from "./rng";

// What the pet needs from the fight it is in.
export type PetHost = {
  readonly now: number;
  readonly queue: EventQueue;
  readonly rng: Rng;
  readonly durationMs: number;
  hunterModded(base: number, spell: Spell, op: number): number;
  rangedAttackPower(): number;
  armorMultiplier(): number;
  // Damage-done bonuses the pet shares with the hunter (Focused Fire).
  sharedDamagePct(): number;
  record(name: string, outcome: "hit" | "crit" | "miss" | "glance" | "tick" | "cast", amount?: number): void;
  report(what: string): void;
};

type PetAura = { spell: Spell; effects: ResolvedEffect[]; expiresAt: number; token: number };

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

const IGNORED_PET_AURAS = new Set<number>([
  13, 22, 29, 31, 49, 61, 77, 101, 118, 133, 142, 230, 563, // defensive, cosmetic or out of scope
  Aura.ProcTriggerSpell, // handled by the proc check
]);

export class Pet {
  private focus = 100;
  private focusAt = 0;
  private gcdReadyAt = 0;
  private readonly cooldowns = new Map<number, number>();
  private readonly auras = new Map<number, PetAura>();
  private passives: { spell: Spell; effects: ResolvedEffect[] }[] = [];
  private readonly abilities: Spell[];
  private auraToken = 0;
  private wakeAt = -1;
  private effectsCache: ResolvedEffect[] | null = null;

  constructor(
    private host: PetHost,
    private data: HunterData,
    private o: Overrides["pet"],
    readonly family: PetFamily,
    level: number,
    priority: string[] | undefined,
  ) {
    // Passive values settle once, with the hunter's talents applied through spell modifiers.
    for (const id of [...data.petPassives, family.passiveSpellId]) {
      const spell = data.spells[String(id)]!;
      const effects = resolveEffects(spell).map((e) =>
        e.index === 0 ? { ...e, value: host.hunterModded(e.value, spell, SpellModOp.Effect1) } : e,
      );
      this.passives.push({ spell, effects });
    }

    const known = new Map<string, Spell>();
    for (const a of data.abilities) {
      if (a.tab !== "Pets" || !family.abilities.includes(a.name)) continue;
      const rank = a.ranks.filter((r) => r.level <= level).at(-1);
      if (rank) known.set(snake(a.name), data.spells[String(rank.spellId)]!);
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

  private effects(): ResolvedEffect[] {
    if (this.effectsCache) return this.effectsCache;
    const out: ResolvedEffect[] = [];
    for (const p of this.passives) out.push(...p.effects);
    for (const a of this.auras.values()) out.push(...a.effects);
    return (this.effectsCache = out);
  }

  private sum(aura: number, misc?: number): number {
    let s = 0;
    for (const e of this.effects()) if (e.aura === aura && (misc === undefined || e.miscValue[0] === misc)) s += e.value;
    return s;
  }

  attackPower(): number {
    return this.o.baseAttackPower.value + (this.host.rangedAttackPower() * this.o.inheritRangedAttackPowerPct.value) / 100 + this.sum(Aura.ModAttackPower);
  }

  private haste(): number {
    let h = 1;
    for (const e of this.effects()) if (e.aura === Aura.ModMeleeHaste) h *= 1 + e.value / 100;
    return h;
  }

  private damageMultiplier(school: number): number {
    let m = (1 + this.o.happinessDamagePct.value / 100) * (1 + this.host.sharedDamagePct() / 100);
    for (const e of this.effects()) {
      if (e.aura === Aura.ModDamagePercentDone && (e.miscValue[0] & school) !== 0) m *= 1 + e.value / 100;
    }
    return m;
  }

  private critPct(): number {
    return this.o.baseCritPct.value + this.sum(Aura.ModCritPct);
  }

  private focusNow(): number {
    const regen = this.o.focusPerSecond.value * (1 + this.sum(Aura.ModPowerRegenPercent, 2) / 100);
    return Math.min(100, this.focus + (regen * (this.host.now - this.focusAt)) / 1000);
  }

  private focusRate(): number {
    return (this.o.focusPerSecond.value * (1 + this.sum(Aura.ModPowerRegenPercent, 2) / 100)) / 1000;
  }

  // White swings ===============================================================

  private swing(): void {
    const rng = this.host.rng.stream("pet-auto").next() * 100;
    const miss = this.o.missPct.value;
    const dodge = miss + this.o.dodgePct.value;
    const glance = dodge + this.o.glancingPct.value;
    const crit = glance + this.critPct();
    const speed = this.o.attackSpeedSec.value;

    if (rng < dodge) {
      this.host.record("Pet: Melee", "miss");
    } else {
      const base = this.host.rng.stream("pet-damage").range(this.o.baseDamage.min, this.o.baseDamage.max);
      let amount = (base + (this.attackPower() / 14) * speed) * this.damageMultiplier(School.Physical) * this.host.armorMultiplier();
      if (rng < glance) {
        amount *= 1 - this.o.glancingPenaltyPct.value / 100;
        this.host.record("Pet: Melee", "glance", amount);
      } else if (rng < crit) {
        this.host.record("Pet: Melee", "crit", amount * 2);
        this.onCrit();
      } else {
        this.host.record("Pet: Melee", "hit", amount);
      }
    }
    this.host.queue.push(this.host.now + (speed * 1000) / this.haste(), () => this.swing());
  }

  // Frenzy and anything like it: the client marks no "on crit" flag, the tooltips do.
  private onCrit(): void {
    for (const p of this.passives) {
      const proc = p.spell.proc;
      if (!proc) continue;
      for (const e of p.effects) {
        if (e.aura !== Aura.ProcTriggerSpell || !e.triggerSpell) continue;
        const chance = this.host.hunterModded(proc.chance, p.spell, SpellModOp.ProcChance);
        if (!this.host.rng.stream(`pet-proc:${p.spell.id}`).chance(chance)) continue;
        const triggered = this.data.spells[String(e.triggerSpell)]!;
        this.addAura(triggered, resolveEffects(triggered), triggered.durationMs);
      }
    }
  }

  // Abilities ==================================================================

  private act(): void {
    const now = this.host.now;
    if (now < this.gcdReadyAt) return this.wake(this.gcdReadyAt);

    let next = Infinity;
    for (const spell of this.abilities) {
      const ready = this.cooldowns.get(spell.id) ?? 0;
      if (ready > now) {
        next = Math.min(next, ready);
        continue;
      }
      const cost = spell.power.find((p) => p.type === 2)?.cost ?? 0;
      const focus = this.focusNow();
      if (focus < cost) {
        next = Math.min(next, now + Math.ceil((cost - focus) / this.focusRate()));
        continue;
      }
      this.focus = focus - cost;
      this.focusAt = now;
      this.use(spell);
      this.gcdReadyAt = now + spell.gcdMs;
      const cd = Math.max(spell.cooldownMs, spell.categoryCooldownMs);
      if (cd > 0) this.cooldowns.set(spell.id, now + cd);
      return this.wake(this.gcdReadyAt);
    }
    if (next !== Infinity) this.wake(next);
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
      if (this.host.rng.stream("pet-special-crit").chance(this.critPct())) {
        this.host.record(name, "crit", amount * 2);
        this.onCrit();
      } else {
        this.host.record(name, "hit", amount);
      }
    }

    for (const e of auraEffects) {
      if (!IGNORED_PET_AURAS.has(e.aura) && e.aura !== Aura.PeriodicDamage && e.aura !== Aura.ModMeleeHaste && e.aura !== Aura.ModAttackPower && e.aura !== Aura.ModDamagePercentDone) {
        this.host.report(`${name} (${spell.id}): aura ${e.aura}`);
      }
    }
    const dots = auraEffects.filter((e) => e.aura === Aura.PeriodicDamage);
    for (const e of dots) {
      const tick = e.value * this.damageMultiplier(spell.school);
      for (let t = e.periodMs; t <= spell.durationMs; t += e.periodMs) {
        if (this.host.now + t < this.host.durationMs) this.host.queue.push(this.host.now + t, () => this.host.record(name, "tick", tick));
      }
    }
    // Buffs on the pet itself (Trickster's Dance, Furious Howl).
    const buffs = auraEffects.filter((e) => e.aura !== Aura.PeriodicDamage && !TARGET_ENEMY.has(e.implicitTarget[0]));
    if (buffs.length > 0) this.addAura(spell, buffs, spell.durationMs);
  }

  // Auras ======================================================================

  addAura(spell: Spell, effects: ResolvedEffect[], durationMs: number): void {
    const token = ++this.auraToken;
    const expiresAt = this.host.now + (durationMs < 0 ? Infinity : durationMs);
    this.auras.set(spell.id, { spell, effects, expiresAt, token });
    this.effectsCache = null;
    if (expiresAt !== Infinity) {
      this.host.queue.push(expiresAt, () => {
        if (this.auras.get(spell.id)?.token !== token) return;
        this.auras.delete(spell.id);
        this.effectsCache = null;
      });
    }
  }
}

const TARGET_ENEMY = new Set([6, 25]);
