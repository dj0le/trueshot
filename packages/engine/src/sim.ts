// One fight, start to finish. The hunter acts from a priority list; everything else (auto shot,
// regen, ticks, aura expiry) runs off the event queue.
import { atLevel, type GameData, type Spell } from "@hunter-sim/data";
import { AuraSet } from "./auras";
import { type ActiveSpell, type Character, type MeleeWeapon, type ResolvedEffect, resolveEffects } from "./character";
import { Cooldowns } from "./cooldowns";
import {
  Aura,
  CHANNELED_FLAGS,
  CreatureType,
  DefenseType,
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
import { attackTable } from "./levels";
import { Pet, type PetHost } from "./pet";
import { EventQueue } from "./queue";
import { Rng } from "./rng";
import type { Rotation } from "./rotation";
import { type ScriptContext, type Scripts, scriptsFor } from "./scripts";
import { HunterStats, type Target } from "./stats";

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
  Effect.TriggerSpell,
  Effect.PersistentAreaAura,
  Effect.SummonObject,
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

// Attributes_0 flags of an attack that replaces the next melee swing (Raptor Strike).
const NEXT_SWING_FLAGS = 0x4 | 0x400;
const isNextSwing = (spell: Spell) => (spell.attributes[0]! & NEXT_SWING_FLAGS) !== 0;
const traps = new WeakMap<Spell, boolean>();
const isTrap = (spell: Spell) => {
  let trap = traps.get(spell);
  if (trap === undefined) traps.set(spell, (trap = spell.effects.some((e) => e.effect === Effect.SummonObject)));
  return trap;
};

// Melee abilities reach 5 yards; shots have an 8 yard minimum.
const MELEE_RANGE = 5;
// Melee abilities, and traps: a trap springs only within reach of the target, so the hunter places
// it in melee.
const isMeleeOnly = (spell: Spell) => isTrap(spell) || (spell.rangeMax > 0 && spell.rangeMax <= MELEE_RANGE);

// Procs per minute as a chance per hit, in percent, for a weapon of this speed.
const ppmChance = (ppm: number, speedSec: number) => (ppm * speedSec * 100) / 60;

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
  // Mana still in the bar when the fight ends: spent on nothing.
  manaLeft: number;
  // Time spent able to act but without the mana to cast anything on the list.
  oomMs: number;
};

export type { GameData };

export class Fight implements PetHost {
  now = 0;
  readonly queue = new EventQueue();
  readonly rng: Rng;
  mana: number;
  manaSpent = 0;
  lastManaSpendAt = -Infinity;
  gcdReadyAt = 0;
  casting: { spell: Spell; endsAt: number } | null = null;
  private readonly cooldowns = new Cooldowns();
  readonly selfAuras: AuraSet;
  readonly targetAuras: AuraSet;
  readonly auto = { cooldownEnd: 0, windup: false, firesAt: Infinity, token: 0 };
  // Where the hunter is: shooting, in melee, or walking between the two while weaving. Melee
  // position stays in melee and swings on its own timers; weaving swings only on arrival.
  private at: "ranged" | "toMelee" | "melee" | "toRanged";
  private readonly weaving: boolean;
  private readonly swingReadyAt = { mainHand: 0, offHand: 0 };
  // An attack queued on the next main-hand swing (Raptor Strike).
  private queuedSwing: Spell | null = null;
  private wakeAt = -1;
  private oomSince: number | null = null;
  private oomMs = 0;
  private readonly stats = new Map<string, AbilityStats>();
  private readonly target: Target;
  readonly calc: HunterStats;
  private readonly autoShot: Spell;
  readonly attackPowerPerDps: number;
  private readonly support: number[];
  private readonly scriptContext: ScriptContext;
  private readonly scripts: Scripts;
  // The hawk's dive is the hunter's spell, but the hawk deals it, so "pets and hawks" talents reach it.
  private readonly hawkDive: Set<number>;
  readonly pet: Pet | null = null;
  // What reaches hawks: the pet passives the "pets and hawks" talents modify (Unleashed Fury,
  // Ferocity), without the pet's family bonus or its own buffs (Bestial Wrath).
  readonly hawkAuras: AuraSet;

  constructor(
    private ch: Character,
    private game: GameData,
    private rotation: Rotation,
    readonly durationMs: number,
    seed: string,
    private unimplemented: Set<string>,
  ) {
    this.rng = new Rng(seed);
    this.at = ch.config.position === "melee" ? "melee" : "ranged";
    this.weaving = ch.config.position === "weave";
    this.selfAuras = new AuraSet(this.queue, ch.passives, (effects) => this.calc.aurasChanged(effects));
    this.targetAuras = new AuraSet(this.queue);
    this.mana = ch.maxMana;
    const lv = game.overrides.levels;
    const t = ch.config.target;
    const targetLevel = t.level ?? ch.level + game.overrides.targets[t.preset]!.levelOffset;
    this.target = {
      level: targetLevel,
      armor: t.armor ?? atLevel(lv, lv.creatureArmor.values, targetLevel),
      table: attackTable(game.overrides.formula, ch.level, targetLevel),
      creatureMask: 1 << (CreatureType[t.creatureType] - 1),
    };
    this.calc = new HunterStats(ch, game, this.selfAuras, this.targetAuras, this.target);
    this.autoShot = game.data.spells["75"]!;
    this.attackPowerPerDps = game.overrides.formula.attackPowerPerDps.value;
    const preset = ch.config.support;
    const support = preset === "solo" ? [] : game.overrides.support[preset]?.spells;
    if (!support) throw new Error(`support: unknown preset "${preset}"`);
    this.support = support;
    const shared: ActiveSpell[] = game.data.petPassives.map((id) => {
      const spell = game.data.spells[String(id)]!;
      return { spell, effects: this.calc.moddedEffects(spell, resolveEffects(spell)), source: spell.name };
    });
    this.hawkAuras = new AuraSet(this.queue, shared);
    if (ch.config.pet.active) {
      const family = game.data.petFamilies.find((p) => p.name === ch.config.pet.family);
      if (!family) throw new Error(`pet: unknown family "${ch.config.pet.family}"`);
      const attackingUntil = (durationMs * ch.config.pet.attackingPct) / 100;
      const pet = { level: ch.level, baseAttackPower: atLevel(lv, lv.pet.attackPower.values, ch.level), table: this.target.table };
      this.pet = new Pet(this, game.data, game.overrides.pet, family, pet, ch.config.pet.abilities, attackingUntil);
      for (const a of ch.config.rotation.actions) {
        if (a.pet && !this.pet.knows(a.pet)) throw new Error(`rotation: a ${family.name} does not know "${a.pet}" (${a.action})`);
      }
    }
    this.scripts = scriptsFor(game.data);
    this.hawkDive = this.scripts.ranks("Summon Hawk");
    this.scriptContext = {
      data: game.data,
      config: ch.config,
      applySpell: (id, values) => {
        const spell = game.data.spells[String(id)]!;
        const effects = resolveEffects(spell).map((e) => ({ ...e, value: values?.[e.index] ?? e.value }));
        this.applyAuras(spell, effects);
      },
      resetCooldowns: (actions) => {
        for (const name of actions) {
          const spell = ch.abilities.get(name);
          if (spell) this.cooldowns.reset(spell);
        }
      },
      bleed: (id, total) => this.bleed(game.data.spells[String(id)]!, total),
      targetHas: (name) => rotation.idsOf(name).some((id) => this.targetAuras.get(id)),
      summonHawk: () => {
        if (this.pet) this.pet.summonHawk();
        else this.report("Summon Hawk without a pet out: the hawk's attacks are not simulated");
      },
    };
  }

  // Setup =====================================================================

  run(): FightResult {
    this.rotation.fight = this;
    // Like rotation actions, precombat spells the character does not know (level, talents) are skipped.
    for (const name of this.ch.config.rotation.precombat) {
      const spell = this.ch.abilities.get(name);
      if (spell) this.applyAuras(spell, null);
    }
    // A hunter keeps tracking the target's creature type, which Improved Tracking turns into damage.
    const tracking = [...this.ch.abilities.values()].find((s) =>
      s.effects.some((e) => e.aura === Aura.ModDamageDoneVersusCreature && (e.miscValue[0] & this.target.creatureMask) !== 0),
    );
    if (tracking) this.applyAuras(tracking, null);
    // Other players keep these up all fight.
    for (const id of this.support) this.applyAuras(this.game.data.spells[String(id)]!, null, Infinity);
    for (let t = 2000; t < this.durationMs; t += 2000) this.queue.push(t, () => this.manaTick());
    if (this.ch.config.position !== "ranged" && !this.ch.mainHand) this.report(`${this.ch.config.position} position without a melee weapon in the main hand`);
    if (this.at === "melee") {
      if (this.ch.mainHand) this.swing(this.ch.mainHand, false);
      if (this.ch.offHand) this.swing(this.ch.offHand, true);
    } else this.tryWindup();
    this.act();
    // The pet goes in on the opening macro, after what it sends (Intimidation, Bestial Wrath) lands.
    this.pet?.start();

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
      manaLeft: this.mana,
      oomMs: this.oomMs,
    };
  }

  // Results ===================================================================

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

  cooldownReadyAt(spell: Spell): number {
    return this.cooldowns.readyAt(spell);
  }

  // Acting =====================================================================

  // Shots need distance and melee abilities need the target in reach; self buffs work anywhere.
  private inRange(spell: Spell): boolean {
    if (spell.rangeMin > 0) return this.at === "ranged";
    return isMeleeOnly(spell) ? this.at === "melee" : true;
  }

  // Self auras raising a caster aura state (overrides auraState). Mongoose Bite needs state 1, set
  // by a dodge or by Expose Prey's activation; the hunter is not tanking, so only Expose Prey.
  // Counterattack needs a parry (state 7), which never happens without tanking.
  private hasState(state: number): boolean {
    return this.game.overrides.auraState.some((a) => a.state === state && this.selfAuras.get(a.spell));
  }

  private useState(state: number): void {
    for (const a of this.game.overrides.auraState) if (a.state === state) this.selfAuras.remove(a.spell);
  }

  private moving(): boolean {
    return this.at === "toMelee" || this.at === "toRanged";
  }

  // ignoreGcd: castable once the GCD is back.
  private canCast(spell: Spell, ignoreGcd = false): boolean {
    // Cheap checks first: this runs for every action on every wake.
    if (this.casting || this.queuedSwing === spell) return false;
    if (!ignoreGcd && spell.gcdMs > 0 && this.now < this.gcdReadyAt) return false;
    if (this.cooldownReadyAt(spell) > this.now || !this.inRange(spell)) return false;
    // Casts and channels need the hunter standing still.
    if (this.moving() && (spell.castTimeMs > 0 || isChanneled(spell))) return false;
    if (spell.casterAuraState && !this.hasState(spell.casterAuraState)) return false;
    return this.mana >= this.calc.manaCost(spell);
  }

  private act(): void {
    for (let guard = 0; guard < 8; guard++) {
      const pick = this.rotation.actions.find((a) => a.spell && this.canCast(a.spell) && (!a.cond || a.cond()));
      if (!pick) break;
      this.cast(pick.spell!);
      if (pick.pet) this.pet?.command(pick.pet);
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
          this.inRange(a.spell) &&
          this.cooldownReadyAt(a.spell) <= this.now &&
          this.mana < this.calc.manaCost(a.spell) &&
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
    // Raptor Strike waits for the next main-hand swing, which it replaces.
    if (isNextSwing(spell)) {
      this.queuedSwing = spell;
      return;
    }
    if (spell.gcdMs > 0) this.gcdReadyAt = this.now + spell.gcdMs;
    this.record(spell.name, "cast");
    if (spell.casterAuraState) this.useState(spell.casterAuraState);

    if (isChanneled(spell)) {
      this.complete(spell);
      this.channel(spell);
      return;
    }
    const castMs = this.calc.castTime(spell);
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
      this.considerWeave();
    });
  }

  private complete(spell: Spell): void {
    const cost = this.calc.manaCost(spell);
    if (cost > 0) {
      this.mana -= cost;
      this.manaSpent += cost;
      this.lastManaSpendAt = this.now;
    }
    const cd = Math.max(spell.cooldownMs, spell.categoryCooldownMs);
    this.cooldowns.start(spell, this.now, cd > 0 ? Math.max(0, this.calc.modded(cd, spell, SpellModOp.Cooldown)) : 0);
  }

  // A channel occupies the hunter for its whole duration, like a long cast, while its auras tick.
  private channel(spell: Spell): void {
    this.cancelWindup();
    const endsAt = this.now + Math.max(0, this.calc.modded(spell.durationMs, spell, SpellModOp.Duration));
    this.casting = { spell, endsAt };
    this.applyAuras(spell, null);
    this.queue.push(endsAt, () => {
      this.casting = null;
      this.tryWindup();
      this.considerWeave();
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
    if (this.at !== "ranged" || this.channeling() || this.auto.windup || this.now < this.auto.cooldownEnd) return;
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
    this.record(spell.name, "cast");
    this.execute(spell, true);
    const speed = this.ch.rangedWeapon.speed * 1000;
    this.auto.cooldownEnd = this.now + Math.max(0, speed / this.calc.rangedHaste() - this.windupMs());
    this.queue.push(this.auto.cooldownEnd, () => this.tryWindup());
    // Weaving: the hunter sees the shot go and decides whether to walk in.
    if (this.weaving) this.queue.push(this.now + REACTION_MS, () => this.considerWeave());
  }

  // Melee weaving =============================================================
  // After an Auto Shot (or a cast) the hunter walks in when the main-hand swing will be ready by
  // arrival and the walk back pushes the next Auto Shot back by no more than weave.maxAutoShotDelayMs.
  // In melee: whatever the rotation can use there, the swing (Raptor Strike if queued), and straight
  // back out; Auto Shot restarts a reaction after arriving. Ready shots go first: a cast started
  // here holds the hunter in place. Modelled on wowsims/forever's hunter weave (PR 575).

  private legMs(): number {
    const w = this.ch.config.weave;
    return (1000 * Math.max(0, w.shootRangeYd - w.meleeRangeYd)) / this.calc.runSpeed();
  }

  private considerWeave(): void {
    if (!this.weaving || this.at !== "ranged" || !this.ch.mainHand) return;
    this.act();
    if (this.casting || this.auto.windup) return;
    const leg = this.legMs();
    const arrive = this.now + leg;
    if (this.swingReadyAt.mainHand > arrive) return;
    const autoShotBack = arrive + leg + REACTION_MS;
    if (autoShotBack - Math.max(this.now, this.auto.cooldownEnd) > this.ch.config.weave.maxAutoShotDelayMs) return;
    this.at = "toMelee";
    this.record("Melee weave", "cast");
    this.queue.push(arrive, () => this.arriveInMelee());
  }

  private arriveInMelee(): void {
    this.at = "melee";
    this.act();
    this.strike(this.ch.mainHand!, false);
    if (this.ch.offHand && this.swingReadyAt.offHand <= this.now) this.strike(this.ch.offHand, true);
    this.leaveMelee(false);
  }

  // The hunter walks back out once nothing keeps them in melee: a cast or channel started here
  // finishes first, and a reactive melee ability the rotation wants but the GCD holds (Mongoose
  // Bite opened by the swing, gone if left) gets one wait for the GCD. Other melee abilities wait
  // for the next weave.
  private leaveMelee(waited: boolean): void {
    this.act();
    if (this.casting) {
      this.queue.push(this.casting.endsAt, () => this.leaveMelee(waited));
      return;
    }
    const held = this.rotation.actions.some(
      (a) => a.spell && a.spell.casterAuraState && isMeleeOnly(a.spell) && this.canCast(a.spell, true) && !this.canCast(a.spell) && (!a.cond || a.cond()),
    );
    if (held && !waited) {
      this.queue.push(this.gcdReadyAt, () => this.leaveMelee(true));
      return;
    }
    this.at = "toRanged";
    this.queue.push(this.now + this.legMs(), () => {
      this.at = "ranged";
      this.queue.push(Math.max(this.now + REACTION_MS, this.auto.cooldownEnd), () => this.tryWindup());
    });
  }

  // Melee swings ==============================================================
  // In melee position each weapon swings on its own timer. A queued next-swing attack replaces the
  // main hand's white swing when its cooldown and mana allow.

  private swing(weapon: MeleeWeapon, offHand: boolean): void {
    this.strike(weapon, offHand);
    this.queue.push(this.swingReadyAt[offHand ? "offHand" : "mainHand"], () => this.swing(weapon, offHand));
  }

  // One swing of a weapon, and when that weapon can swing again.
  private strike(weapon: MeleeWeapon, offHand: boolean): void {
    const q = offHand ? null : this.queuedSwing;
    if (!offHand) this.queuedSwing = null;
    if (q && this.cooldownReadyAt(q) <= this.now && this.mana >= this.calc.manaCost(q)) {
      this.record(q.name, "cast");
      this.complete(q);
      this.execute(q);
    } else this.whiteSwing(weapon, offHand);
    this.swingReadyAt[offHand ? "offHand" : "mainHand"] = this.now + (weapon.speed * 1000) / this.calc.meleeHaste();
  }

  // One roll for the whole table: miss (more while dual wielding), dodge, glance, crit, hit. Attacks
  // come from behind, so nothing is parried or blocked.
  private whiteSwing(weapon: MeleeWeapon, offHand: boolean): void {
    const f = this.game.overrides.formula;
    const t = this.target.table;
    const name = offHand ? "Melee (off hand)" : "Melee";
    this.record(name, "cast");
    const dualWield = this.ch.offHand ? f.dualWieldMissPct.value : 0;
    const miss = this.calc.missPct() + dualWield;
    const dodge = miss + t.dodgePct;
    const glance = dodge + t.glancingPct;
    const crit = glance + this.calc.critPct(null);
    const r = this.rng.stream("melee").next() * 100;
    if (r < dodge) {
      this.record(name, "miss");
      return;
    }
    let amount = this.meleeWeaponDamage(weapon, weapon.speed);
    if (offHand) amount *= (f.offHandDamagePct.value / 100) * (1 + this.selfAuras.sum(Aura.ModOffhandDamagePct) / 100);
    amount *= this.calc.damageDone(School.Physical) * this.calc.ownArmorMultiplier();
    if (r < glance) this.record(name, "glance", amount * (1 - t.glancingPenaltyPct / 100));
    else if (r < crit) this.record(name, "crit", amount * this.calc.critMultiplier(null));
    else this.record(name, "hit", amount);
    this.selfAuras.consumeCharges(ProcFlag.DoneMeleeAutoAttack);
    this.afterHit(ProcFlag.DoneMeleeAutoAttack, ProcFlag.TakenMeleeAutoAttack, weapon.procs, weapon.speed, r >= glance && r < crit);
  }

  // Resolving a spell =========================================================

  private roll(spell: Spell, isAuto: boolean, extraCritPct = 0): "miss" | "hit" | "crit" {
    if (spell.defenseType === DefenseType.None) return "hit";
    // The hunter's magic (trap fire) misses on the spell table; hunter spell crit is not modelled.
    if (spell.defenseType === DefenseType.Magic) {
      const miss = Math.max(1, this.target.table.spellMissPct - this.calc.mods(spell, SpellModOp.ResistMissChance).flat);
      return this.rng.stream("spell").chance(miss) ? "miss" : "hit";
    }
    // Melee specials can also be dodged.
    const miss = this.calc.missPct() + (spell.defenseType === DefenseType.Melee ? this.target.table.dodgePct : 0);
    const crit = this.calc.critPct(spell, extraCritPct);
    const r = this.rng.stream(isAuto ? "auto" : "special").next() * 100;
    if (r < miss) return "miss";
    // Auto attacks use one roll for the whole table; special attacks roll crit separately.
    if (isAuto) return r < miss + crit ? "crit" : "hit";
    return this.rng.stream("special-crit").chance(crit) ? "crit" : "hit";
  }

  // Melee abilities hit with the main hand and melee attack power, shots with the ranged weapon.
  private weaponDamage(spell: Spell, normalized: boolean): number {
    if (spell.defenseType === DefenseType.Melee) {
      const w = this.ch.mainHand;
      return w ? this.meleeWeaponDamage(w, normalized ? w.normalizedSpeed : w.speed) : 0;
    }
    const g = this.ch.config.gear;
    const w = this.ch.rangedWeapon;
    const speed = normalized ? this.game.overrides.formula.normalizedRangedSpeed.value : w.speed;
    return this.rng.stream("damage").range(w.min, w.max) + g.ammoDps * speed + (this.calc.rangedAttackPower() / this.attackPowerPerDps) * speed;
  }

  private meleeWeaponDamage(w: MeleeWeapon, speed: number): number {
    return this.rng.stream("damage").range(w.min, w.max) + (this.calc.meleeAttackPower() / this.attackPowerPerDps) * speed;
  }

  // A spell's damage before modifiers. A weapon percent effect scales the weapon damage effects
  // (Counterattack: (weapon + 110) * 50% = 50% weapon damage plus 55), or the plain weapon hit when
  // it stands alone (Scatter Shot).
  private spellDamage(spell: Spell, damaging: ResolvedEffect[]): number {
    const percent = damaging.filter((e) => e.effect === Effect.WeaponPercentDamage);
    const weapon = damaging.filter((e) => e.effect === Effect.WeaponDamage || e.effect === Effect.NormalizedWeaponDamage);
    let amount = weapon.reduce((sum, e) => sum + this.weaponDamage(spell, e.effect === Effect.NormalizedWeaponDamage) + e.value, 0);
    if (percent.length > 0) {
      if (weapon.length === 0) amount = this.weaponDamage(spell, false);
      amount *= percent.reduce((m, e) => (m * e.value) / 100, 1);
    }
    // Percent modifiers on all effects raise a spell's direct damage too (Clever Traps).
    for (const e of damaging) {
      if (e.effect !== Effect.SchoolDamage) continue;
      amount += this.calc.modded(this.rolled(e, "damage"), spell, SpellModOp.AllEffects) + e.apCoefficient * this.calc.attackPowerFor(spell);
    }
    return amount;
  }

  // fromProc: a weapon proc's own spell, which cannot set off another.
  private execute(spell: Spell, isAuto = false, fromProc = false): void {
    // Procs are cast by nothing else, so they count their own.
    if (fromProc) this.record(spell.name, "cast");
    const effects = resolveEffects(spell);
    for (const e of effects) {
      if (!KNOWN_EFFECTS.has(e.effect)) this.report(`${spell.name} (${spell.id}): effect ${e.effect}`);
    }
    // Damage to the caster (Demonic Rune's health cost) is not damage done.
    const damaging = effects.filter((e) => DAMAGE_EFFECTS.has(e.effect) && e.implicitTarget[0] !== TARGET_CASTER);
    // Spells that deal no damage and put nothing on the enemy (Intimidation, Bestial Wrath) cannot miss.
    const canMiss = damaging.length > 0 || effects.some((e) => TARGET_ENEMY.has(e.implicitTarget[0]));
    const hawk = this.hawkDive.has(spell.id);
    const outcome = isChanneled(spell) || !canMiss ? "hit" : this.roll(spell, isAuto, hawk ? this.hawkAuras.sum(Aura.ModCritPct) : 0);
    if (outcome === "miss") {
      this.record(spell.name, "miss");
      return;
    }
    let dealt = 0;

    if (damaging.length > 0) {
      let amount = this.spellDamage(spell, damaging);
      amount = this.calc.modded(amount, spell, SpellModOp.Damage) * this.calc.damageDone(spell.school);
      if (hawk) amount *= this.hawkAuras.damageMultiplier(spell.school);
      if (spell.school === School.Physical) amount *= this.calc.ownArmorMultiplier();
      if (outcome === "crit") amount *= this.calc.critMultiplier(spell);
      this.record(spell.name, outcome, amount);
      dealt = amount;
    } else if (!isTrap(spell)) {
      // Placing a trap is not a hit; its spell, under the same name, counts when it springs.
      this.record(spell.name, "hit");
    }

    this.energize(effects);
    this.triggerLinked(spell, effects);
    this.placeTraps(spell, effects);

    // Charges go after the damage they applied to and before this spell's own auras land, so a
    // shot that grants charged buffs does not spend one itself.
    const ranged = spell.defenseType === DefenseType.Ranged;
    const melee = spell.defenseType === DefenseType.Melee;
    const flag = melee ? ProcFlag.DoneMeleeSpell : isAuto ? ProcFlag.DoneRangedAutoAttack : ProcFlag.DoneRangedSpell;
    if (ranged || melee) this.selfAuras.consumeCharges(flag);
    this.applyAuras(spell, effects);
    this.scripts.onLand.get(spell.id)?.(this.scriptContext, { spell, damage: dealt });
    if (ranged) {
      const taken = isAuto ? ProcFlag.TakenRangedAutoAttack : ProcFlag.TakenRangedSpell;
      this.afterHit(flag, taken, fromProc ? [] : this.ch.weaponProcs, this.ch.rangedWeapon.speed, outcome === "crit");
    }
    const w = this.ch.mainHand;
    if (melee && w) this.afterHit(flag, ProcFlag.TakenMeleeSpell, fromProc ? [] : w.procs, w.speed, outcome === "crit");
  }

  // What a landed attack sets off, with the speed of the weapon it came from: the hunter's procs,
  // the weapon's chance-on-hit effects, and debuffs on the target that answer being hit.
  private afterHit(done: number, taken: number, weaponProcs: Spell[], speed: number, crit: boolean): void {
    this.procs(this.selfAuras, done, "proc", speed, crit);
    this.weaponProcs(weaponProcs, speed);
    this.procs(this.targetAuras, taken, "target-proc", speed, crit);
  }

  // A trap lies where the hunter stands and springs on the target if that is within reach (in melee),
  // once armed. Out of reach it never springs.
  private placeTraps(spell: Spell, effects: ResolvedEffect[]): void {
    for (const e of effects) {
      if (e.effect !== Effect.SummonObject || !e.triggerSpell) continue;
      const linked = this.linkedSpell(spell, e.triggerSpell, "trap");
      if (!linked || this.at !== "melee") continue;
      this.queue.push(this.now + this.game.overrides.formula.trapArmingMs.value, () => this.execute(linked));
    }
  }

  // Bleeds on the target carrying damage already done, by spell: the tick, when the next one lands
  // and how many are left.
  private readonly bleeds = new Map<number, { tick: number; nextAt: number; left: number }>();

  // A bleed carrying damage already done (Lacerating Strikes): ticks of an equal share over the
  // spell's duration, with no further modifiers. A new one refreshes the old the way Deep Wounds
  // does: the unticked damage is added, the sum spread over a full set of ticks, and the ticks keep
  // the old timer (wowsims/forever talents_survival.go; in-game testing required).
  private bleed(spell: Spell, total: number): void {
    const e = spell.effects.find((x) => x.aura === Aura.PeriodicDamage)!;
    const ticks = Math.max(1, Math.floor(spell.durationMs / e.periodMs));
    const prev = this.targetAuras.get(spell.id) ? this.bleeds.get(spell.id) : undefined;
    const first = prev ? prev.nextAt - this.now : e.periodMs;
    const state = { tick: ((prev ? prev.tick * prev.left : 0) + total) / ticks, nextAt: this.now + first, left: ticks };
    this.bleeds.set(spell.id, state);
    const duration = first + (ticks - 1) * e.periodMs;
    this.targetAuras.add(spell, [], this.now, duration, (isLive) =>
      this.everyTick(
        e.periodMs,
        duration,
        isLive,
        () => {
          this.record(spell.name, "tick", state.tick);
          state.left--;
          state.nextAt += e.periodMs;
        },
        first,
      ),
    );
  }

  // Runs fn at each tick of a periodic effect while its aura lives, the first `firstMs` from now.
  // Ticks past the end of the fight never happen; this also bounds auras that last forever.
  private everyTick(periodMs: number, durationMs: number, isLive: () => boolean, fn: () => void, firstMs = periodMs): void {
    const until = Math.min(durationMs, this.durationMs - this.now);
    for (let t = firstMs; t <= until; t += periodMs) {
      this.queue.push(this.now + t, () => {
        if (isLive()) fn();
      });
    }
  }

  // An effect's value with its variance rolled; variance is the full width as a fraction of the value.
  private rolled(e: ResolvedEffect, stream: string): number {
    const spread = e.variance ? this.rng.stream(stream).range(-e.variance / 2, e.variance / 2) : 0;
    return e.value * (1 + spread);
  }

  private gainMana(amount: number): void {
    this.mana = Math.min(this.ch.maxMana, this.mana + amount);
  }

  // Mana restored by a spell's energize effects (potions, runes, Judgement of Wisdom).
  private energize(effects: ResolvedEffect[]): void {
    for (const e of effects) {
      if (e.effect !== Effect.Energize || e.miscValue[0] !== 0) continue;
      this.gainMana(this.rolled(e, "energize"));
    }
  }

  // A proc's triggered spell: its mana, its auras, and any link it hands on to. `parentMs`: how long
  // the aura that set it off has left; a buff the client marks as lasting until cancelled ends with it
  // (Jom Gabbar's stacks end with Jom Gabbar).
  private trigger(spell: Spell, parentMs?: number): void {
    const effects = resolveEffects(spell);
    this.energize(effects);
    this.triggerLinked(spell, effects);
    this.applyAuras(spell, effects, spell.durationMs < 0 && parentMs !== undefined ? parentMs : undefined);
  }

  // Spells a spell sets off on the hunter at once: a trigger effect (Jom Gabbar), or a server-side
  // link on a dummy (Judgement of Wisdom).
  private triggerLinked(spell: Spell, effects: ResolvedEffect[]): void {
    for (const e of effects) {
      if (!e.triggerSpell || (e.effect !== Effect.Dummy && e.effect !== Effect.TriggerSpell)) continue;
      const linked = this.linkedSpell(spell, e.triggerSpell, "linked");
      if (linked) this.trigger(linked, spell.durationMs > 0 ? spell.durationMs : undefined);
    }
  }

  // The spell an effect sets off, or undefined (reported) when the data lacks it.
  private linkedSpell(from: Spell, id: number, kind: string): Spell | undefined {
    const linked = this.game.data.spells[String(id)];
    if (!linked) this.report(`${from.name}: ${kind} spell ${id} not in the data`);
    return linked;
  }

  // Auras =====================================================================

  private applyAuras(spell: Spell, effects: ResolvedEffect[] | null, durationOverride?: number): void {
    const all = effects ?? resolveEffects(spell);
    const auraEffects = this.calc.moddedEffects(
      spell,
      all.filter(
        (e) =>
          e.effect === Effect.ApplyAura ||
          e.effect === Effect.ApplyAreaAuraRaid ||
          e.effect === Effect.ApplyAreaAuraParty ||
          e.effect === Effect.PersistentAreaAura,
      ),
    );
    if (auraEffects.length === 0) return;
    for (const e of auraEffects) {
      if (!KNOWN_AURAS.has(e.aura as never)) this.report(`${spell.name} (${spell.id}): aura ${e.aura}`);
    }

    // A ground area lies under the target.
    const atTarget = (e: ResolvedEffect) => TARGET_ENEMY.has(e.implicitTarget[0]) || e.effect === Effect.PersistentAreaAura;
    const onTarget = auraEffects.filter(atTarget);
    const onPet = auraEffects.filter((e) => e.implicitTarget[0] === TARGET_PET);
    const onSelf = auraEffects.filter((e) => !atTarget(e) && e.implicitTarget[0] !== TARGET_PET);
    const duration =
      durationOverride ?? (spell.durationMs < 0 ? Infinity : this.calc.modded(spell.durationMs, spell, SpellModOp.Duration));
    if (onPet.length > 0) this.pet?.addAura(spell, onPet, duration);
    if (onSelf.length > 0) this.addAura(this.selfAuras, spell, onSelf, duration);
    if (onTarget.length > 0) this.addAura(this.targetAuras, spell, onTarget, duration);
  }

  private addAura(auras: AuraSet, spell: Spell, effects: ResolvedEffect[], duration: number): void {
    auras.add(spell, effects, this.now, duration, (isLive) => {
      const each = (e: ResolvedEffect, fn: () => void) => this.everyTick(e.periodMs, duration, isLive, fn);
      for (const e of effects) {
        if (e.aura === Aura.PeriodicEnergize && e.miscValue[0] === 0) each(e, () => this.gainMana(e.value));
        // Periodic dummies fire a linked spell each tick (Volley), rolling and scaling like a cast.
        else if (e.aura === Aura.PeriodicDummy && e.triggerSpell) {
          const triggered = this.linkedSpell(spell, e.triggerSpell, "periodic");
          if (triggered) each(e, () => this.execute(triggered));
        }
        // Periodic triggers apply a linked spell each tick (Jom Gabbar's stacks).
        else if (e.aura === Aura.PeriodicTriggerSpell && e.triggerSpell) {
          const triggered = this.linkedSpell(spell, e.triggerSpell, "periodic");
          const endsAt = this.now + duration;
          if (triggered) each(e, () => this.trigger(triggered, endsAt - this.now));
        }
        // Periodic damage snapshots its tick when applied.
        else if (e.aura === Aura.PeriodicDamage) {
          const tick =
            this.calc.modded(e.value + e.apCoefficient * this.calc.rangedAttackPower(), spell, SpellModOp.PeriodicDamage) *
            this.calc.damageDone(spell.school);
          each(e, () => this.record(spell.name, "tick", tick));
        }
      }
    });
  }

  // A weapon's chance-on-hit effects (Dark Iron Rifle's Shadow Shot), at a rate per minute the
  // client does not carry (overrides.toml formula.weaponProcPpm).
  private weaponProcs(procs: Spell[], speed: number): void {
    if (procs.length === 0) return;
    const chance = ppmChance(this.game.overrides.formula.weaponProcPpm.value, speed);
    for (const spell of procs) {
      if (this.rng.stream(`weapon-proc:${spell.id}`).chance(chance)) this.execute(spell, false, true);
    }
  }

  // When each proc aura can fire again after its internal cooldown (Primal Blessing's 72 sec).
  private readonly procReadyAt = new Map<number, number>();

  // Self auras that answer the hunter's own hits, and debuffs on the target that answer being hit
  // (Judgement of Wisdom). `speed`: the hitting weapon's, which procs per minute scale by.
  private procs(auras: AuraSet, flag: number, stream: string, speed: number, crit: boolean): void {
    for (const src of auras.sources()) {
      const proc = src.spell.proc;
      if (!proc || (proc.typeMask[0] & flag) === 0) continue;
      if (proc.critOnly && !crit) continue;
      if ((this.procReadyAt.get(src.spell.id) ?? 0) > this.now) continue;
      const procIf = this.scripts.procIf.get(src.spell.id);
      if (procIf && !procIf(this.scriptContext)) continue;
      for (const e of src.effects) {
        if (e.aura !== Aura.ProcTriggerSpell || !e.triggerSpell) continue;
        const serverRate = proc.ppm === 0 && proc.serverRate && proc.chance >= 100;
        const ppm = serverRate ? this.game.overrides.formula.weaponProcPpm.value : proc.ppm;
        const base = ppm > 0 ? ppmChance(ppm, speed) : proc.chance;
        if (serverRate) this.report(`${src.spell.name}: proc rate is set by the server, simulated at formula.weaponProcPpm (${ppm} per minute)`);
        else if (base > 100 && proc.ppm === 0) this.report(`${src.spell.name}: proc chance is set by the server, simulated as every hit`);
        const chance = this.calc.modded(base, src.spell, SpellModOp.ProcChance);
        if (!this.rng.stream(`${stream}:${src.spell.id}`).chance(chance)) continue;
        if (proc.categoryRecoveryMs > 0) this.procReadyAt.set(src.spell.id, this.now + proc.categoryRecoveryMs);
        const triggered = this.linkedSpell(src.spell, e.triggerSpell, "proc");
        if (!triggered) continue;
        // A proc that strikes the enemy (Hurricane's Frost Arrow) is an attack of its own, which
        // cannot set off another proc.
        if (resolveEffects(triggered).some((t) => DAMAGE_EFFECTS.has(t.effect) && t.implicitTarget[0] !== TARGET_CASTER)) this.execute(triggered, false, true);
        // A buff the proc grants ends with the aura that procs it (Badge of the Swarmguard's stacks).
        else this.trigger(triggered, src.expiresAt !== Infinity ? src.expiresAt - this.now : undefined);
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
    this.gainMana(gain);
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
