// The hunter's cooldowns: each spell's own, and each category's lockout on the other spells in it
// (Summon Hawk after Arcane Shot, a trinket after another).
import type { Spell } from "@hunter-sim/data";

export class Cooldowns {
  private readonly own = new Map<number, number>();
  private readonly categories = new Map<number, { readyAt: number; by: number }>();

  readyAt(spell: Spell): number {
    const c = this.categories.get(spell.category);
    const shared = c && c.by !== spell.id ? c.readyAt : 0;
    return Math.max(this.own.get(spell.id) ?? 0, shared);
  }

  // `ownMs`: the spell's own cooldown after modifiers. They shorten only that, not the lockout its
  // category shares (Improved Arcane Shot: "shared cooldowns are not affected").
  start(spell: Spell, now: number, ownMs: number): void {
    if (ownMs > 0) this.own.set(spell.id, now + ownMs);
    if (spell.category && spell.categoryCooldownMs) {
      this.categories.set(spell.category, { readyAt: now + spell.categoryCooldownMs, by: spell.id });
    }
  }

  // Ready again at once, and the category lockout it started lifted.
  reset(spell: Spell): void {
    this.own.delete(spell.id);
    if (this.categories.get(spell.category)?.by === spell.id) this.categories.delete(spell.category);
  }
}
