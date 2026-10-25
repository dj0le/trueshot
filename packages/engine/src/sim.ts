// One fight, start to finish. The hunter acts from a priority list; everything else (auto shot,
// regen, ticks, aura expiry) runs off the event queue.
import type { GameData, Overrides, Spell } from "@hunter-sim/data";
import { AuraSet } from "./auras";
import { type Character, type ResolvedEffect, resolveEffects, snake } from "./character";
import {
  Aura,
  CHANNELED_FLAGS,
  DefenseType,
  EFFECT_VALUE_OPS,
  Effect,
  IGNORED_AURAS,
  IGNORED_EFFECTS,
  ProcFlag,
  School,
  SpellModOp,
  TARGET_CASTER,
  TARGET_ENEMY,
  TARGET_PET,
} from "./enums";
import { compile, type Getter } from "./expr";
import { Pet, type PetHost } from "./pet";
import { EventQueue } from "./queue";
import { Rng } from "./rng";
import { ON_LAND, type ScriptContext } from "./scripts";

const DAMAGE_EFFECTS = new Set<number>([
  Effect.SchoolDamage,
  Effect.WeaponDamage,
  Effect.WeaponPercentDamage,
  Effect.NormalizedWeaponDamage,
]);
// Effects and auras the engine understands. Anything else in a spell that gets used is reported.
const KNOWN_EFFECTS = new Set<number>([
  ...DAMAGE_EFFECTS,
  Effect.ApplyAura,
  Effect.ApplyAreaAuraRaid,
  Effect.ApplyAreaAuraParty,
  Effect.Energize,
  Effect.Dummy,
  ...IGNORED_EFFECTS,
]);
const KNOWN_AURAS = new Set<number>([...Object.values(Aura), ...IGNORED_AURAS]);

// Talent passives whose auras the engine does not read, for the run's "not simulated" list.
export function unknownPassiveAuras(ch: Character): string[] {
  return ch.passives.flatMap((p) =>
    p.effects.filter((e) => e.effect === Effect.ApplyAura && !KNOWN_AURAS.has(e.aura)).map((e) => `${p.source}: aura ${e.aura}`),
  );
}

// How long the rotation takes to notice a condition that turned true just because time passed
// (time > 30, buff.x.remains < 2): a human reaction delay. The exact alternative would have each
// time-based getter report when it next crosses its threshold and wake the fight then; this
// polling is simpler and arguably more realistic. Change it here if that ever matters.
const REACTION_MS = 100;

const isChanneled = (spell: Spell) => (spell.attributes[1]! & CHANNELED_FLAGS) !== 0;

export type AbilityStats = {
  name: string;
  casts: number;
  hits: number;
  crits: number;
  misses: number;
  ticks: number;
  damage: number;
};

export type FightResult = {
  durationMs: number;
  damage: number;
  abilities: AbilityStats[];
  manaSpent: number;
  // Time spent able to act but without the mana to cast anything on the list.
  oomMs: number;
};

type Target = Overrides["targets"][string];

export type { GameData };

// The rotation, compiled once and pointed at whichever fight is running.
export class Rotation {
  fight: Fight | null = null;
  // timed: the condition reads something that changes with time alone, so the fight re-checks it
  // every REACTION_MS while it holds the action back.
  readonly actions: { name: string; spell: Spell | null; cond: Getter | null; timed: boolean }[];
  // Spell ids by snake_case name, for conditions that look up auras.
  private readonly spellIds = new Map<string, number[]>();

  constructor(
    private ch: Character,
    private game: GameData,
  ) {
    for (const s of Object.values(game.data.spells)) {
      const key = snake(s.name);
      this.spellIds.set(key, [...(this.spellIds.get(key) ?? []), s.id]);
    }
    const knownNames = new Set([
      ...game.data.abilities.filter((a) => a.tab !== "Pets").map((a) => snake(a.name)),
      ...game.data.consumables.map((c) => snake(c.name)),
      ...game.data.racials.filter((r) => r.active).map((r) => snake(r.name)),
    ]);
    this.actions = ch.config.rotation.actions.map((a) => {
      if (!knownNames.has(a.action)) throw new Error(`rotation: unknown action "${a.action}"`);
      let timed = false;
      const cond = a.if
        ? compile(a.if, (path) => {
            if (["time", "fight", "target"].includes(path[0]!) || path.at(-1)?.endsWith("remains")) timed = true;
            return this.resolve(path);
          })
        : null;
      // spell is null when the character does not know it (level or talents); the action is skipped.
      return { name: a.action, spell: ch.abilities.get(a.action) ?? null, cond, timed };
    });
  }

  private f(): Fight {
    return this.fight!;
  }

  private resolve(path: string[]): Getter {
    const [head, name, field] = path;
    const needSpellName = () => {
      if (!name || !this.spellIds.has(name)) throw new Error(`rotation: unknown spell "${name}" in ${path.join(".")}`);
    };
    const sec = (ms: number) => Math.max(0, ms) / 1000;

    switch (head) {
      case "time":
        return () => this.f().now / 1000;
      case "fight":
        if (name === "remains") return () => sec(this.f().durationMs - this.f().now);
        break;
      case "target":
        if (name === "health" && field === "pct") return () => 100 * (1 - this.f().now / this.f().durationMs);
        break;
      case "mana":
        if (name === "pct") return () => (100 * this.f().mana) / this.ch.maxMana;
        if (name === "current") return () => this.f().mana;
        if (name === "deficit") return () => this.ch.maxMana - this.f().mana;
        break;
      case "gcd":
        if (name === "remains") return () => sec(this.f().gcdReadyAt - this.f().now);
        break;
      case "hawks":
        if (name === "active") return () => this.f().pet?.activeHawks() ?? 0;
        if (name === "min_remains") return () => sec(this.f().pet?.hawkMinRemainsMs() ?? 0);
        break;
      case "haste":
        return () => this.f().rangedHaste();
      case "auto_shot":
        if (name === "remains") return () => sec(this.f().autoShotFiresAt() - this.f().now);
        if (name === "windup") return () => (this.f().auto.windup ? 1 : 0);
        break;
      case "cooldown": {
        needSpellName();
        const spell = this.ch.abilities.get(name!);
        if (field === "ready") return () => (spell && this.f().cooldownReadyAt(spell) <= this.f().now ? 1 : 0);
        if (field === "remains") return () => (spell ? sec(this.f().cooldownReadyAt(spell) - this.f().now) : 1e9);
        break;
      }
      case "casts": {
        // Times cast so far this fight, for fixed patterns: (casts.a + casts.b) % 3 < 2.
        if (field !== undefined) break;
        needSpellName();
        const spell = this.ch.abilities.get(name!);
        return () => (spell ? this.f().castCount(spell) : 0);
      }
      case "cast": {
        needSpellName();
        const spell = this.ch.abilities.get(name!);
        if (field === "time") return () => (spell ? this.f().castTime(spell) / 1000 : 0);
        break;
      }
      case "buff":
      case "debuff":
      case "dot": {
        needSpellName();
        const onTarget = head !== "buff";
        const ids = this.spellIds.get(name!)!;
        const find = () => {
          const auras = onTarget ? this.f().targetAuras : this.f().selfAuras;
          for (const id of ids) {
            const a = auras.get(id);
            if (a) return a;
          }
          return undefined;
        };
        if (field === "up" || field === "ticking") return () => (find() ? 1 : 0);
        if (field === "remains") return () => {
          const a = find();
          return a ? sec(a.expiresAt - this.f().now) : 0;
        };
        break;
      }
    }
    throw new Error(`rotation: unknown expression "${path.join(".")}"`);
  }
}

export class Fight implements PetHost {
  now = 0;
  readonly queue = new EventQueue();
  readonly rng: Rng;
  mana: number;
  manaSpent = 0;
  lastManaSpendAt = -Infinity;
  gcdReadyAt = 0;
  casting: { spell: Spell; endsAt: number } | null = null;
  // Ready times by spell id, and by category for spells sharing a category cooldown.
  private readonly spellCooldowns = new Map<number, number>();
  private readonly categoryCooldowns = new Map<number, number>();
  readonly selfAuras: AuraSet;
  readonly targetAuras: AuraSet;
  readonly auto = { cooldownEnd: 0, windup: false, firesAt: Infinity, token: 0 };
  private wakeAt = -1;
  private oomSince: number | null = null;
  private oomMs = 0;
  private readonly stats = new Map<string, AbilityStats>();
  private readonly target: Target;
  private readonly autoShot: Spell;
  readonly attackPowerPerDps: number;
  private readonly support: number[];
  private readonly scriptContext: ScriptContext;
  readonly pet: Pet | null = null;

  constructor(
    private ch: Character,
    private game: GameData,
    private rotation: Rotation,
    readonly durationMs: number,
    seed: string,
    private unimplemented: Set<string>,
  ) {
    this.rng = new Rng(seed);
    this.selfAuras = new AuraSet(this.queue, ch.passives, () => this.modsCache.clear());
    this.targetAuras = new AuraSet(this.queue);
    this.mana = ch.maxMana;
    this.target = game.overrides.targets[ch.config.target.preset]!;
    this.autoShot = game.data.spells["75"]!;
    this.attackPowerPerDps = game.overrides.formula.attackPowerPerDps.value;
    const preset = ch.config.support;
    if (preset !== "solo" && !game.overrides.support[preset]) throw new Error(`support: unknown preset "${preset}"`);
    this.support = preset === "solo" ? [] : game.overrides.support[preset]!.spells;
    if (ch.config.pet.active) {
      const family = game.data.petFamilies.find((p) => p.name === ch.config.pet.family);
      if (!family) throw new Error(`pet: unknown family "${ch.config.pet.family}"`);
      this.pet = new Pet(this, game.data, game.overrides.pet, family, ch.level, ch.config.pet.abilities);
    }
    this.scriptContext = {
      data: game.data,
      config: ch.config,
      applySpell: (id, values) => {
        const spell = game.data.spells[String(id)]!;
        const effects = resolveEffects(spell).map((e) => ({ ...e, value: values?.[e.index] ?? e.value }));
        this.applyAuras(spell, effects);
      },
      summonHawk: () => {
        if (this.pet) this.pet.summonHawk();
        else this.report("Summon Hawk without a pet out: the hawk's attacks are not simulated");
      },
    };
  }

  // Setup =====================================================================

  run(): FightResult {
    this.rotation.fight = this;
    for (const name of this.ch.config.rotation.precombat) {
      const spell = this.ch.abilities.get(name);
      if (!spell) throw new Error(`precombat: "${name}" is not known at level ${this.ch.level} with these talents`);
      this.applyAuras(spell, null);
    }
    // Other players keep these up all fight.
    for (const id of this.support) this.applyAuras(this.game.data.spells[String(id)]!, null, Infinity);
    for (let t = 2000; t < this.durationMs; t += 2000) this.queue.push(t, () => this.manaTick());
    this.pet?.start();
    this.tryWindup();
    this.act();

    for (;;) {
      const time = this.queue.peekTime();
      if (time === undefined || time >= this.durationMs) break;
      this.now = time;
      this.queue.pop()!.run();
      if (this.queue.peekTime() !== time) this.act();
    }
    this.now = this.durationMs;
    if (this.oomSince !== null) this.oomMs += this.now - this.oomSince;

    const abilities = [...this.stats.values()];
    return {
      durationMs: this.durationMs,
      damage: abilities.reduce((s, a) => s + a.damage, 0),
      abilities,
      manaSpent: this.manaSpent,
      oomMs: this.oomMs,
    };
  }

  // Stats in combat ===========================================================

  // Spell modifier sums, rebuilt only when self auras change.
  private readonly modsCache = new Map<number, { flat: number; pct: number }>();

  rangedAttackPower(): number {
    const fromInt = (this.selfAuras.sum(Aura.ModRangedAttackPowerOfStatPercent) / 100) * this.ch.primary.intellect;
    const flat =
      this.ch.rangedAttackPower +
      this.selfAuras.sum(Aura.ModRangedAttackPower) +
      this.targetAuras.sum(Aura.RangedAttackPowerAttackerBonus) +
      fromInt;
    return flat * this.selfAuras.product([Aura.ModRangedAttackPowerPct]);
  }

  rangedHaste(): number {
    const base = (1 + this.ch.config.gear.quiverHastePct / 100) * (1 + this.ch.hastePct / 100);
    return this.selfAuras.product([Aura.ModRangedHaste, Aura.ModRangedAmmoHaste, Aura.ModMeleeRangedHaste2], base);
  }

  // Sum of AddFlatModifier and AddPctModifier values for one spell and one modifier kind.
  private mods(spell: Spell, op: number): { flat: number; pct: number } {
    const key = spell.id * 32 + op;
    const cached = this.modsCache.get(key);
    if (cached) return cached;
    const mask = spell.classOptions?.mask;
    let flat = 0;
    let pct = 0;
    if (mask) {
      for (const e of this.selfAuras.effects()) {
        if (e.aura !== Aura.AddFlatModifier && e.aura !== Aura.AddPctModifier) continue;
        if (e.miscValue[0] !== op) continue;
        if (!e.classMask.some((m, i) => (m & mask[i]!) !== 0)) continue;
        if (e.aura === Aura.AddFlatModifier) flat += e.value;
        else pct += e.value;
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

  record(name: string, outcome: "hit" | "crit" | "miss" | "glance" | "tick" | "cast", amount = 0): void {
    const s = this.stat(name);
    if (outcome === "cast") s.casts++;
    else if (outcome === "miss") s.misses++;
    else if (outcome === "crit") s.crits++;
    else if (outcome === "tick") s.ticks++;
    else s.hits++;
    s.damage += amount;
  }

  castCount(spell: Spell): number {
    return this.stats.get(spell.name)?.casts ?? 0;
  }

  report(what: string): void {
    this.unimplemented.add(what);
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

  armorMultiplier(): number {
    const f = this.game.overrides.formula;
    const armor = Math.max(0, this.target.armor - this.ch.config.target.armorReduction);
    const k = f.armorConstantBase.value + f.armorConstantPerLevel.value * this.ch.level;
    return 1 - armor / (armor + k);
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

  cooldownReadyAt(spell: Spell): number {
    return Math.max(this.spellCooldowns.get(spell.id) ?? 0, this.categoryCooldowns.get(spell.category) ?? 0);
  }

  // Acting =====================================================================

  private canCast(spell: Spell): boolean {
    if (this.casting) return false;
    if (spell.gcdMs > 0 && this.now < this.gcdReadyAt) return false;
    if (this.cooldownReadyAt(spell) > this.now) return false;
    return this.mana >= this.manaCost(spell);
  }

  private act(): void {
    for (let guard = 0; guard < 8; guard++) {
      const pick = this.rotation.actions.find((a) => a.spell && this.canCast(a.spell) && (!a.cond || a.cond()));
      if (!pick) break;
      this.cast(pick.spell!);
    }
    this.trackOom();
    this.scheduleWake();
  }

  // Wake up when a cooldown or the GCD the rotation is waiting on comes back.
  private scheduleWake(): void {
    if (this.casting) return;
    let next = Infinity;
    if (this.gcdReadyAt > this.now) next = this.gcdReadyAt;
    for (const a of this.rotation.actions) {
      if (!a.spell) continue;
      const ready = this.cooldownReadyAt(a.spell);
      if (ready > this.now) next = Math.min(next, ready);
      // Castable but held back by a time-based condition (act() just ran, so it is false).
      else if (a.timed && this.canCast(a.spell)) next = Math.min(next, this.now + REACTION_MS);
    }
    if (next === Infinity || (this.wakeAt > this.now && this.wakeAt <= next)) return;
    this.wakeAt = next;
    this.queue.push(next, () => {});
  }

  // Out of mana: free to act, and an action the list wants right now (off cooldown, condition
  // true) costs more mana than there is. Runs after act(), so nothing wanted was castable.
  private trackOom(): void {
    const starved =
      !this.casting &&
      this.now >= this.gcdReadyAt &&
      this.rotation.actions.some(
        (a) =>
          a.spell &&
          this.cooldownReadyAt(a.spell) <= this.now &&
          this.mana < this.manaCost(a.spell) &&
          (!a.cond || a.cond()),
      );
    if (starved && this.oomSince === null) this.oomSince = this.now;
    if (!starved && this.oomSince !== null) {
      this.oomMs += this.now - this.oomSince;
      this.oomSince = null;
    }
  }

  // The GCD starts with the cast; mana and the cooldown are taken when the cast completes.
  private cast(spell: Spell): void {
    if (spell.gcdMs > 0) this.gcdReadyAt = this.now + spell.gcdMs;
    this.stat(spell.name).casts++;

    if (isChanneled(spell)) {
      this.complete(spell);
      this.channel(spell);
      return;
    }
    const castMs = this.castTime(spell);
    if (castMs <= 0) {
      this.complete(spell);
      this.execute(spell);
      return;
    }
    // Auto Shot keeps firing through the cast (see the Auto Shot section).
    const endsAt = this.now + castMs;
    this.casting = { spell, endsAt };
    this.queue.push(endsAt, () => {
      this.casting = null;
      this.complete(spell);
      this.execute(spell);
    });
  }

  private complete(spell: Spell): void {
    const cost = this.manaCost(spell);
    if (cost > 0) {
      this.mana -= cost;
      this.manaSpent += cost;
      this.lastManaSpendAt = this.now;
    }
    const cd = Math.max(spell.cooldownMs, spell.categoryCooldownMs);
    if (cd > 0) {
      const readyAt = this.now + Math.max(0, this.modded(cd, spell, SpellModOp.Cooldown));
      if (spell.category && spell.categoryCooldownMs) this.categoryCooldowns.set(spell.category, readyAt);
      else this.spellCooldowns.set(spell.id, readyAt);
    }
  }

  // A channel occupies the hunter for its whole duration, like a long cast, while its auras tick.
  private channel(spell: Spell): void {
    this.cancelWindup();
    const endsAt = this.now + Math.max(0, this.modded(spell.durationMs, spell, SpellModOp.Duration));
    this.casting = { spell, endsAt };
    this.applyAuras(spell, null);
    this.queue.push(endsAt, () => {
      this.casting = null;
      this.tryWindup();
    });
  }

  // Auto Shot =================================================================
  // The last 0.5 sec of each swing is a wind-up the hunter must stand still for. In Forever, unlike
  // Classic, Auto Shot fires while Aimed Shot or Sniper Shot is being cast (Blizzard: intentional,
  // Class Highlights Part 2; https://github.com/classic-hunter/forever-hunter/wiki/Forever-Beta-Changes).
  // Channels (Volley) still hold the shot until they end: no source covers them yet.

  private channeling(): boolean {
    return this.casting !== null && isChanneled(this.casting.spell);
  }

  private windupMs(): number {
    return this.game.overrides.formula.autoShotStandStillMs.value;
  }

  autoShotFiresAt(): number {
    if (this.auto.windup) return this.auto.firesAt;
    const start = Math.max(this.auto.cooldownEnd, this.channeling() ? this.casting!.endsAt : 0, this.now);
    return start + this.windupMs();
  }

  private tryWindup(): void {
    if (this.channeling() || this.auto.windup || this.now < this.auto.cooldownEnd) return;
    this.auto.windup = true;
    this.auto.firesAt = this.now + this.windupMs();
    const token = ++this.auto.token;
    this.queue.push(this.auto.firesAt, () => {
      if (token !== this.auto.token) return;
      this.auto.windup = false;
      this.fireAutoShot();
    });
  }

  private cancelWindup(): void {
    if (!this.auto.windup) return;
    this.auto.windup = false;
    this.auto.token++;
  }

  private fireAutoShot(): void {
    const spell = this.autoShot;
    this.stat(spell.name).casts++;
    this.execute(spell, true);
    const speed = this.ch.rangedWeapon.speed * 1000;
    this.auto.cooldownEnd = this.now + Math.max(0, speed / this.rangedHaste() - this.windupMs());
    this.queue.push(this.auto.cooldownEnd, () => this.tryWindup());
  }

  // Resolving a spell =========================================================

  private roll(spell: Spell, isAuto: boolean): "miss" | "hit" | "crit" {
    if (spell.defenseType === DefenseType.None) return "hit";
    const t = this.target;
    const miss = Math.max(0, t.baseMissPct - Math.max(0, this.ch.hitPct - t.hitPenaltyPct));
    const crit = Math.max(
      0,
      this.ch.critPct + this.selfAuras.sum(Aura.ModCritPct) + this.mods(spell, SpellModOp.CritChance).flat - t.critSuppressionPct,
    );
    const r = this.rng.stream(isAuto ? "auto" : "special").next() * 100;
    if (r < miss) return "miss";
    // Auto attacks use one roll for the whole table; special attacks roll crit separately.
    if (isAuto) return r < miss + crit ? "crit" : "hit";
    return this.rng.stream("special-crit").chance(crit) ? "crit" : "hit";
  }

  private weaponDamage(normalized: boolean): number {
    const g = this.ch.config.gear;
    const w = this.ch.rangedWeapon;
    const speed = normalized ? this.game.overrides.formula.normalizedRangedSpeed.value : w.speed;
    return this.rng.stream("damage").range(w.min, w.max) + g.ammoDps * speed + (this.rangedAttackPower() / this.attackPowerPerDps) * speed;
  }

  private effectDamage(spell: Spell, e: ResolvedEffect): number {
    switch (e.effect) {
      case Effect.WeaponDamage:
        return this.weaponDamage(false) + e.value;
      case Effect.NormalizedWeaponDamage:
        return this.weaponDamage(true) + e.value;
      case Effect.WeaponPercentDamage:
        return (this.weaponDamage(false) * e.value) / 100;
      case Effect.SchoolDamage: {
        const spread = e.variance ? this.rng.stream("damage").range(-e.variance / 2, e.variance / 2) : 0;
        return e.value * (1 + spread) + e.apCoefficient * this.rangedAttackPower();
      }
    }
    return 0;
  }

  private execute(spell: Spell, isAuto = false): void {
    const effects = resolveEffects(spell);
    for (const e of effects) {
      if (!KNOWN_EFFECTS.has(e.effect)) this.unimplemented.add(`${spell.name} (${spell.id}): effect ${e.effect}`);
    }
    // Damage to the caster (Demonic Rune's health cost) is not damage done.
    const damaging = effects.filter((e) => DAMAGE_EFFECTS.has(e.effect) && e.implicitTarget[0] !== TARGET_CASTER);
    // Spells that deal no damage and put nothing on the enemy (Intimidation, Bestial Wrath) cannot miss.
    const canMiss = damaging.length > 0 || effects.some((e) => TARGET_ENEMY.has(e.implicitTarget[0]));
    const outcome = isChanneled(spell) || !canMiss ? "hit" : this.roll(spell, isAuto);
    const s = this.stat(spell.name);
    if (outcome === "miss") {
      s.misses++;
      return;
    }

    if (damaging.length > 0) {
      let amount = damaging.reduce((sum, e) => sum + this.effectDamage(spell, e), 0);
      amount = this.modded(amount, spell, SpellModOp.Damage) * this.selfAuras.damageMultiplier(spell.school);
      if (spell.school === School.Physical) amount *= this.armorMultiplier();
      if (outcome === "crit") {
        const bonus = this.game.overrides.formula.critDamageBonusPct.value / 100;
        amount *= 1 + bonus * (1 + this.mods(spell, SpellModOp.CritDamageBonus).pct / 100);
        // Endurance and Earth Fury: "critical strike bonus to damage increased by 2%", read as 2% more
        // total critical damage, as the same aura worked on TBC's meta gems.
        amount *= this.selfAuras.product([Aura.ModCritDamageBonus]);
        s.crits++;
      } else {
        s.hits++;
      }
      s.damage += amount;
    } else {
      s.hits++;
    }

    this.energize(spell, effects);

    // Charges go after the damage they applied to and before this spell's own auras land, so a
    // shot that grants charged buffs does not spend one itself.
    const flag = isAuto ? ProcFlag.DoneRangedAutoAttack : ProcFlag.DoneRangedSpell;
    if (spell.defenseType === DefenseType.Ranged) this.selfAuras.consumeCharges(flag);
    this.applyAuras(spell, effects);
    ON_LAND[spell.name]?.(this.scriptContext);
    if (spell.defenseType === DefenseType.Ranged) {
      this.procs(flag);
      this.targetProcs(isAuto ? ProcFlag.TakenRangedAutoAttack : ProcFlag.TakenRangedSpell);
    }
  }

  private gainMana(amount: number): void {
    this.mana = Math.min(this.ch.maxMana, this.mana + amount);
  }

  // Mana restored by a spell's energize effects (potions, runes, Judgement of Wisdom).
  private energize(spell: Spell, effects: ResolvedEffect[]): void {
    for (const e of effects) {
      if (e.effect !== Effect.Energize || e.miscValue[0] !== 0) continue;
      const spread = e.variance ? this.rng.stream("energize").range(-e.variance / 2, e.variance / 2) : 0;
      this.gainMana(e.value * (1 + spread));
    }
  }

  // A proc's triggered spell: its mana, its auras, and any server-side link it hands on to.
  private trigger(spell: Spell): void {
    const effects = resolveEffects(spell);
    this.energize(spell, effects);
    for (const e of effects) {
      if (e.effect === Effect.Dummy && e.triggerSpell) this.trigger(this.game.data.spells[String(e.triggerSpell)]!);
    }
    this.applyAuras(spell, effects);
  }

  // Auras =====================================================================

  private applyAuras(spell: Spell, effects: ResolvedEffect[] | null, durationOverride?: number): void {
    const all = effects ?? resolveEffects(spell);
    const auraEffects = this.moddedEffects(
      spell,
      all.filter((e) => e.effect === Effect.ApplyAura || e.effect === Effect.ApplyAreaAuraRaid || e.effect === Effect.ApplyAreaAuraParty),
    );
    if (auraEffects.length === 0) return;
    for (const e of auraEffects) {
      if (!KNOWN_AURAS.has(e.aura as never)) this.unimplemented.add(`${spell.name} (${spell.id}): aura ${e.aura}`);
    }

    const onTarget = auraEffects.filter((e) => TARGET_ENEMY.has(e.implicitTarget[0]));
    const onPet = auraEffects.filter((e) => e.implicitTarget[0] === TARGET_PET);
    const onSelf = auraEffects.filter((e) => !TARGET_ENEMY.has(e.implicitTarget[0]) && e.implicitTarget[0] !== TARGET_PET);
    const duration =
      durationOverride ?? (spell.durationMs < 0 ? Infinity : this.modded(spell.durationMs, spell, SpellModOp.Duration));
    if (onPet.length > 0) this.pet?.addAura(spell, onPet, duration);
    if (onSelf.length > 0) this.addAura(this.selfAuras, spell, onSelf, duration);
    if (onTarget.length > 0) this.addAura(this.targetAuras, spell, onTarget, duration);
  }

  private addAura(auras: AuraSet, spell: Spell, effects: ResolvedEffect[], duration: number): void {
    // Ticks past the end of the fight never happen; this also bounds auras that last forever.
    const tickUntil = Math.min(duration, this.durationMs - this.now);
    auras.add(spell, effects, this.now, duration, (isLive) => {
      for (const e of effects.filter((x) => x.aura === Aura.PeriodicEnergize && x.miscValue[0] === 0)) {
        for (let t = e.periodMs; t <= tickUntil; t += e.periodMs) {
          this.queue.push(this.now + t, () => {
            if (isLive()) this.gainMana(e.value);
          });
        }
      }
      // Periodic dummies fire a linked spell each tick (Volley), rolling and scaling like a cast.
      for (const e of effects.filter((x) => x.aura === Aura.PeriodicDummy && x.triggerSpell)) {
        const triggered = this.game.data.spells[String(e.triggerSpell)]!;
        for (let t = e.periodMs; t <= tickUntil; t += e.periodMs) {
          this.queue.push(this.now + t, () => {
            if (isLive()) this.execute(triggered);
          });
        }
      }
      // Periodic damage snapshots its tick when applied.
      for (const e of effects.filter((x) => x.aura === Aura.PeriodicDamage)) {
        const tick =
          this.modded(e.value + e.apCoefficient * this.rangedAttackPower(), spell, SpellModOp.PeriodicDamage) *
          this.selfAuras.damageMultiplier(spell.school);
        for (let t = e.periodMs; t <= tickUntil; t += e.periodMs) {
          this.queue.push(this.now + t, () => {
            if (!isLive()) return;
            const s = this.stat(spell.name);
            s.ticks++;
            s.damage += tick;
          });
        }
      }
    });
  }

  private procs(flag: number): void {
    for (const src of this.selfAuras.sources()) {
      const proc = src.spell.proc;
      if (!proc || (proc.typeMask[0] & flag) === 0) continue;
      for (const e of src.effects) {
        if (e.aura !== Aura.ProcTriggerSpell || !e.triggerSpell) continue;
        const chance = this.modded(proc.chance, src.spell, SpellModOp.ProcChance);
        if (!this.rng.stream(`proc:${src.spell.id}`).chance(chance)) continue;
        const triggered = this.game.data.spells[String(e.triggerSpell)];
        if (!triggered) {
          this.unimplemented.add(`${src.spell.name}: proc spell ${e.triggerSpell} not in the data`);
          continue;
        }
        this.trigger(triggered);
      }
    }
  }

  // Debuffs on the target that answer the hunter's hits (Judgement of Wisdom).
  private targetProcs(flag: number): void {
    for (const src of this.targetAuras.sources()) {
      const proc = src.spell.proc;
      if (!proc || (proc.typeMask[0] & flag) === 0) continue;
      for (const e of src.effects) {
        if (e.aura !== Aura.ProcTriggerSpell || !e.triggerSpell) continue;
        if (this.rng.stream(`target-proc:${src.spell.id}`).chance(proc.chance)) this.trigger(this.game.data.spells[String(e.triggerSpell)]!);
      }
    }
  }

  // Bookkeeping ===============================================================

  private manaTick(): void {
    const f = this.game.overrides.formula;
    let gain = (this.ch.mp5 * 2) / 5;
    const spiritRegen = f.manaPerTickBase.value + this.ch.primary.spirit / f.spiritPerManaPerTick.value;
    const whileCasting = Math.min(100, this.selfAuras.sum(Aura.ModManaRegenInterrupt)) / 100;
    gain += this.now - this.lastManaSpendAt >= 5000 ? spiritRegen : spiritRegen * whileCasting;
    this.mana = Math.min(this.ch.maxMana, this.mana + gain);
  }

  private stat(name: string): AbilityStats {
    let s = this.stats.get(name);
    if (!s) {
      s = { name, casts: 0, hits: 0, crits: 0, misses: 0, ticks: 0, damage: 0 };
      this.stats.set(name, s);
    }
    return s;
  }
}
