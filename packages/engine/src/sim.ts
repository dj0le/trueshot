// One fight, start to finish. The hunter acts from a priority list; everything else (auto shot,
// regen, ticks, aura expiry) runs off the event queue.
import type { GameData, Overrides, Spell } from "@hunter-sim/data";
import { type ActiveSpell, type Character, type ResolvedEffect, resolveEffects, snake } from "./character";
import { Aura, CHANNELED_FLAGS, DefenseType, Effect, IGNORED_AURAS, IGNORED_EFFECTS, ProcFlag, School, SpellModOp } from "./enums";
import { compile, type Getter } from "./expr";
import { Pet, type PetHost } from "./pet";
import { EventQueue } from "./queue";
import { Rng } from "./rng";
import { ON_LAND, type ScriptContext } from "./scripts";

const TARGET_ENEMY = new Set([6, 25]);
const TARGET_PET = 5;
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
  Effect.Dummy,
  ...IGNORED_EFFECTS,
]);
const KNOWN_AURAS = new Set<number>([...Object.values(Aura), ...IGNORED_AURAS]);

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

type AuraInstance = ActiveSpell & { expiresAt: number; token: number };

type Target = Overrides["targets"][string];

export type { GameData };

// The rotation, compiled once and pointed at whichever fight is running.
export class Rotation {
  fight: Fight | null = null;
  readonly actions: { name: string; spell: Spell | null; cond: Getter | null }[];

  constructor(
    private ch: Character,
    private game: GameData,
  ) {
    const knownNames = new Set(game.data.abilities.map((a) => snake(a.name)));
    this.actions = ch.config.rotation.actions.map((a) => {
      if (!knownNames.has(a.action)) throw new Error(`rotation: unknown action "${a.action}"`);
      return {
        name: a.action,
        // null when the character does not know it (level or talents); the action is skipped.
        spell: ch.abilities.get(a.action) ?? null,
        cond: a.if ? compile(a.if, (path) => this.resolve(path)) : null,
      };
    });
  }

  private f(): Fight {
    return this.fight!;
  }

  private resolve(path: string[]): Getter {
    const [head, name, field] = path;
    const spellNames = new Set(Object.values(this.game.data.spells).map((s) => snake(s.name)));
    const needSpellName = () => {
      if (!name || !spellNames.has(name)) throw new Error(`rotation: unknown spell "${name}" in ${path.join(".")}`);
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
        const find = () => {
          const auras = onTarget ? this.f().targetAuras : this.f().selfAuras;
          for (const a of auras.values()) if (snake(a.spell.name) === name) return a;
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
  readonly cooldowns = new Map<string, number>();
  readonly selfAuras = new Map<number, AuraInstance>();
  readonly targetAuras = new Map<number, AuraInstance>();
  readonly auto = { cooldownEnd: 0, windup: false, firesAt: Infinity, token: 0 };
  private auraToken = 0;
  private wakeAt = -1;
  private oomSince: number | null = null;
  private oomMs = 0;
  private readonly stats = new Map<string, AbilityStats>();
  private readonly target: Target;
  private readonly autoShot: Spell;
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
    this.mana = ch.maxMana;
    this.target = game.overrides.targets[ch.config.target.preset]!;
    this.autoShot = game.data.spells["75"]!;
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

  // Passive and self-aura effects, rebuilt only when self auras change.
  private effectsCache: ResolvedEffect[] | null = null;

  private allEffects(): ResolvedEffect[] {
    if (this.effectsCache) return this.effectsCache;
    const out: ResolvedEffect[] = [];
    for (const p of this.ch.passives) out.push(...p.effects);
    for (const a of this.selfAuras.values()) out.push(...a.effects);
    this.effectsCache = out;
    return out;
  }

  private sumSelf(aura: number): number {
    return this.allEffects()
      .filter((e) => e.aura === aura)
      .reduce((s, e) => s + e.value, 0);
  }

  private sumTarget(aura: number): number {
    let s = 0;
    for (const a of this.targetAuras.values()) for (const e of a.effects) if (e.aura === aura) s += e.value;
    return s;
  }

  rangedAttackPower(): number {
    const fromInt = (this.sumSelf(Aura.ModRangedAttackPowerOfStatPercent) / 100) * this.ch.primary.intellect;
    return (
      this.ch.rangedAttackPower +
      this.sumSelf(Aura.ModRangedAttackPower) +
      this.sumTarget(Aura.RangedAttackPowerAttackerBonus) +
      fromInt
    );
  }

  rangedHaste(): number {
    let h = 1 + this.ch.config.gear.quiverHastePct / 100;
    for (const e of this.allEffects()) {
      if (e.aura === Aura.ModRangedHaste || e.aura === Aura.ModRangedAmmoHaste) h *= 1 + e.value / 100;
    }
    return h;
  }

  // Sum of AddFlatModifier and AddPctModifier values for one spell and one modifier kind.
  private mods(spell: Spell, op: number): { flat: number; pct: number } {
    const mask = spell.classOptions?.mask;
    let flat = 0;
    let pct = 0;
    if (!mask) return { flat, pct };
    for (const e of this.allEffects()) {
      if (e.aura !== Aura.AddFlatModifier && e.aura !== Aura.AddPctModifier) continue;
      if (e.miscValue[0] !== op) continue;
      if (!e.classMask.some((m, i) => (m & mask[i]!) !== 0)) continue;
      if (e.aura === Aura.AddFlatModifier) flat += e.value;
      else pct += e.value;
    }
    return { flat, pct };
  }

  hunterModded(base: number, spell: Spell, op: number): number {
    return this.modded(base, spell, op);
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

  report(what: string): void {
    this.unimplemented.add(what);
  }

  private modded(base: number, spell: Spell, op: number): number {
    const { flat, pct } = this.mods(spell, op);
    return (base + flat) * (1 + pct / 100);
  }

  private damageMultiplier(school: number): number {
    let m = 1;
    for (const e of this.allEffects()) {
      if (e.aura === Aura.ModDamagePercentDone && (e.miscValue[0] & school) !== 0) m *= 1 + e.value / 100;
    }
    return m;
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

  private cooldownKey(spell: Spell): string {
    return spell.category && spell.categoryCooldownMs ? `cat:${spell.category}` : `spell:${spell.id}`;
  }

  cooldownReadyAt(spell: Spell): number {
    return Math.max(this.cooldowns.get(`spell:${spell.id}`) ?? 0, this.cooldowns.get(`cat:${spell.category}`) ?? 0);
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
    }
    if (next === Infinity || (this.wakeAt > this.now && this.wakeAt <= next)) return;
    this.wakeAt = next;
    this.queue.push(next, () => {});
  }

  private trackOom(): void {
    const starved =
      !this.casting &&
      this.now >= this.gcdReadyAt &&
      this.rotation.actions.some(
        (a) => a.spell && this.cooldownReadyAt(a.spell) <= this.now && this.mana < this.manaCost(a.spell),
      ) &&
      !this.rotation.actions.some((a) => a.spell && this.canCast(a.spell));
    if (starved && this.oomSince === null) this.oomSince = this.now;
    if (!starved && this.oomSince !== null) {
      this.oomMs += this.now - this.oomSince;
      this.oomSince = null;
    }
  }

  private cast(spell: Spell): void {
    const cost = this.manaCost(spell);
    if (cost > 0) {
      this.mana -= cost;
      this.manaSpent += cost;
      this.lastManaSpendAt = this.now;
    }
    if (spell.gcdMs > 0) this.gcdReadyAt = this.now + spell.gcdMs;
    const cd = Math.max(spell.cooldownMs, spell.categoryCooldownMs);
    if (cd > 0) this.cooldowns.set(this.cooldownKey(spell), this.now + Math.max(0, this.modded(cd, spell, SpellModOp.Cooldown)));
    this.stat(spell.name).casts++;

    if (isChanneled(spell)) {
      this.channel(spell);
      return;
    }
    const castMs = this.castTime(spell);
    if (castMs <= 0) {
      this.execute(spell);
      return;
    }
    // A cast stops an Auto Shot wind-up; the shot waits until the cast ends.
    this.cancelWindup();
    const endsAt = this.now + castMs;
    this.casting = { spell, endsAt };
    this.queue.push(endsAt, () => {
      this.casting = null;
      this.execute(spell);
      this.tryWindup();
    });
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
  // The last 0.5 sec of each swing is a wind-up that must not overlap a cast.

  private windupMs(): number {
    return this.game.overrides.formula.autoShotStandStillMs.value;
  }

  autoShotFiresAt(): number {
    if (this.auto.windup) return this.auto.firesAt;
    const start = Math.max(this.auto.cooldownEnd, this.casting?.endsAt ?? 0, this.now);
    return start + this.windupMs();
  }

  private tryWindup(): void {
    if (this.casting || this.auto.windup || this.now < this.auto.cooldownEnd) return;
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
      this.ch.critPct + this.mods(spell, SpellModOp.CritChance).flat - t.critSuppressionPct,
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
    const apPerDps = this.game.overrides.formula.attackPowerPerDps.value;
    return this.rng.stream("damage").range(w.min, w.max) + g.ammoDps * speed + (this.rangedAttackPower() / apPerDps) * speed;
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
    const damaging = effects.filter((e) => DAMAGE_EFFECTS.has(e.effect));
    const outcome = isChanneled(spell) ? "hit" : this.roll(spell, isAuto);
    const s = this.stat(spell.name);
    if (outcome === "miss") {
      s.misses++;
      return;
    }

    if (damaging.length > 0) {
      let amount = damaging.reduce((sum, e) => sum + this.effectDamage(spell, e), 0);
      amount = this.modded(amount, spell, SpellModOp.Damage) * this.damageMultiplier(spell.school);
      if (spell.school === School.Physical) amount *= this.armorMultiplier();
      if (outcome === "crit") {
        const bonus = this.game.overrides.formula.critDamageBonusPct.value / 100;
        amount *= 1 + bonus * (1 + this.mods(spell, SpellModOp.CritDamageBonus).pct / 100);
        s.crits++;
      } else {
        s.hits++;
      }
      s.damage += amount;
    } else {
      s.hits++;
    }

    this.applyAuras(spell, effects);
    ON_LAND[spell.name]?.(this.scriptContext);
    if (spell.defenseType === DefenseType.Ranged) {
      this.procs(isAuto ? ProcFlag.DoneRangedAutoAttack : ProcFlag.DoneRangedSpell);
    }
  }

  // Auras =====================================================================

  private applyAuras(spell: Spell, effects: ResolvedEffect[] | null): void {
    const all = effects ?? resolveEffects(spell);
    const auraEffects = all.filter((e) => e.effect === Effect.ApplyAura || e.effect === Effect.ApplyAreaAuraRaid);
    if (auraEffects.length === 0) return;
    for (const e of auraEffects) {
      if (!KNOWN_AURAS.has(e.aura as never)) this.unimplemented.add(`${spell.name} (${spell.id}): aura ${e.aura}`);
    }

    const onTarget = auraEffects.filter((e) => TARGET_ENEMY.has(e.implicitTarget[0]));
    const onPet = auraEffects.filter((e) => e.implicitTarget[0] === TARGET_PET);
    const onSelf = auraEffects.filter((e) => !TARGET_ENEMY.has(e.implicitTarget[0]) && e.implicitTarget[0] !== TARGET_PET);
    const duration = spell.durationMs < 0 ? Infinity : this.modded(spell.durationMs, spell, SpellModOp.Duration);
    if (onPet.length > 0) this.pet?.addAura(spell, onPet, duration === Infinity ? -1 : duration);
    if (onSelf.length > 0) this.addAura(this.selfAuras, spell, onSelf, duration);
    if (onTarget.length > 0) this.addAura(this.targetAuras, spell, onTarget, duration);
  }

  private addAura(map: Map<number, AuraInstance>, spell: Spell, effects: ResolvedEffect[], duration: number): void {
    const token = ++this.auraToken;
    const expiresAt = this.now + duration;
    // Periodic dummies fire a linked spell each tick (Volley), rolling and scaling like a cast.
    for (const e of effects.filter((x) => x.aura === Aura.PeriodicDummy && x.triggerSpell)) {
      const triggered = this.game.data.spells[String(e.triggerSpell)]!;
      for (let t = e.periodMs; t <= duration; t += e.periodMs) {
        this.queue.push(this.now + t, () => {
          if (map.get(spell.id)?.token === token) this.execute(triggered);
        });
      }
    }
    // Periodic damage snapshots its tick when applied.
    const periodic = effects.filter((e) => e.aura === Aura.PeriodicDamage);
    map.set(spell.id, { spell, effects, expiresAt, token, source: spell.name });
    this.effectsCache = null;
    for (const e of periodic) {
      const tick =
        (this.modded(e.value + e.apCoefficient * this.rangedAttackPower(), spell, SpellModOp.PeriodicDamage)) *
        this.damageMultiplier(spell.school);
      for (let t = e.periodMs; t <= duration; t += e.periodMs) {
        this.queue.push(this.now + t, () => {
          if (map.get(spell.id)?.token !== token) return;
          const s = this.stat(spell.name);
          s.ticks++;
          s.damage += tick;
        });
      }
    }
    // Scheduled after the ticks, so a tick landing exactly on expiry still happens.
    if (duration !== Infinity) {
      this.queue.push(expiresAt, () => {
        if (map.get(spell.id)?.token !== token) return;
        map.delete(spell.id);
        this.effectsCache = null;
      });
    }
  }

  private procs(flag: number): void {
    const sources: ActiveSpell[] = [...this.ch.passives, ...this.selfAuras.values()];
    for (const src of sources) {
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
        this.applyAuras(triggered, null);
      }
    }
  }

  // Bookkeeping ===============================================================

  private manaTick(): void {
    const f = this.game.overrides.formula;
    let gain = (this.ch.mp5 * 2) / 5;
    const spiritRegen = f.manaPerTickBase.value + this.ch.primary.spirit / f.spiritPerManaPerTick.value;
    const whileCasting = Math.min(100, this.sumSelf(Aura.ModManaRegenInterrupt)) / 100;
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
