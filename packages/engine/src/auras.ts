// The auras on one unit (hunter, target or pet), with its always-on passives, and the sums the
// engine reads off them.
import type { ActiveSpell, ResolvedEffect } from "./character";
import { Aura } from "./enums";
import type { EventQueue } from "./queue";
import type { Spell } from "@hunter-sim/data";

// charges: attacks left before the aura is used up (Intimidation's one guaranteed crit); 0 = no limit.
// stacks: applications so far, for auras that stack (their effects are the base values times this).
export type AuraInstance = ActiveSpell & { expiresAt: number; token: number; charges: number; stacks: number };

export class AuraSet {
  private readonly active = new Map<number, AuraInstance>();
  private token = 0;
  // Passive and aura effects, rebuilt only when an aura comes or goes.
  private cache: ResolvedEffect[] | null = null;

  constructor(
    private readonly queue: EventQueue,
    readonly passives: readonly ActiveSpell[] = [],
    private readonly onChange: () => void = () => {},
  ) {}

  get(spellId: number): AuraInstance | undefined {
    return this.active.get(spellId);
  }

  // Passives first, then active auras.
  sources(): ActiveSpell[] {
    return [...this.passives, ...this.active.values()];
  }

  effects(): ResolvedEffect[] {
    if (this.cache) return this.cache;
    const out: ResolvedEffect[] = [];
    for (const p of this.passives) out.push(...p.effects);
    for (const a of this.active.values()) out.push(...a.effects);
    return (this.cache = out);
  }

  sum(aura: number, misc?: number): number {
    let s = 0;
    for (const e of this.effects()) if (e.aura === aura && (misc === undefined || e.miscValue[0] === misc)) s += e.value;
    return s;
  }

  // Percentage auras that multiply together onto a base, such as haste.
  product(auras: readonly number[], base = 1): number {
    let m = base;
    for (const e of this.effects()) if (auras.includes(e.aura)) m *= 1 + e.value / 100;
    return m;
  }

  // creatureMask: the target's creature type as a mask, for damage done versus creature types.
  damageMultiplier(school: number, creatureMask = 0): number {
    let m = 1;
    for (const e of this.effects()) {
      if (e.aura === Aura.ModDamagePercentDone && (e.miscValue[0] & school) !== 0) m *= 1 + e.value / 100;
      if (e.aura === Aura.ModDamageDoneVersusCreature && (e.miscValue[0] & creatureMask) !== 0) m *= 1 + e.value / 100;
    }
    return m;
  }

  // Applies or refreshes an aura; one that stacks (the client's cumulative count) gains a stack, up to
  // its limit, and refreshes. `schedule` gets a check that stays true while this application is the
  // live one, for periodic effects; it runs before the expiry is queued, so a tick landing exactly on
  // expiry still happens.
  add(
    spell: Spell,
    effects: ResolvedEffect[],
    now: number,
    duration: number,
    schedule?: (isLive: () => boolean) => void,
  ): void {
    const token = ++this.token;
    const expiresAt = now + duration;
    const isLive = () => this.active.get(spell.id)?.token === token;
    const maxStacks = spell.proc?.cumulative ?? 0;
    const stacks = maxStacks > 1 ? Math.min(maxStacks, (this.active.get(spell.id)?.stacks ?? 0) + 1) : 1;
    const stacked = stacks > 1 ? effects.map((e) => ({ ...e, value: e.value * stacks })) : effects;
    this.active.set(spell.id, { spell, effects: stacked, expiresAt, token, source: spell.name, charges: spell.proc?.charges ?? 0, stacks });
    this.changed();
    schedule?.(isLive);
    if (duration !== Infinity) {
      this.queue.push(expiresAt, () => {
        if (!isLive()) return;
        this.active.delete(spell.id);
        this.changed();
      });
    }
  }

  // A successful attack of the given proc flag uses up one charge of each aura listening for it.
  consumeCharges(flag: number): void {
    for (const [id, a] of this.active) {
      if (a.charges === 0 || (a.spell.proc!.typeMask[0] & flag) === 0) continue;
      if (--a.charges === 0) {
        this.active.delete(id);
        this.changed();
      }
    }
  }

  private changed(): void {
    this.cache = null;
    this.onChange();
  }
}
