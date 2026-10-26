// The hunter's priority list: actions in order, each with an optional condition compiled once
// against the names conditions may read (time, mana, cooldowns, auras).
import type { GameData, Spell } from "@hunter-sim/data";
import { actionNames, type Character, snake } from "./character";
import { compile, type Getter } from "./expr";
import type { Fight } from "./sim";

// The rotation, compiled once and pointed at whichever fight is running.
export class Rotation {
  fight: Fight | null = null;
  // timed: the condition reads something that changes with time alone, so the fight re-checks it
  // every REACTION_MS while it holds the action back.
  readonly actions: { name: string; spell: Spell | null; cond: Getter | null; timed: boolean; pet: string | null }[];
  // Spell ids by snake_case name, for conditions that look up auras.
  private readonly spellIds = new Map<string, number[]>();
  private readonly actionNames: Set<string>;

  constructor(
    private ch: Character,
    game: GameData,
  ) {
    for (const s of Object.values(game.data.spells)) {
      const key = snake(s.name);
      this.spellIds.set(key, [...(this.spellIds.get(key) ?? []), s.id]);
    }
    this.actionNames = actionNames(game.data, game.items);
    this.actions = ch.config.rotation.actions.map((a) => {
      if (!this.actionNames.has(a.action)) throw new Error(`rotation: unknown action "${a.action}"`);
      let timed = false;
      const cond = a.if
        ? compile(a.if, (path) => {
            if (["time", "fight", "target"].includes(path[0]!) || path.at(-1)?.endsWith("remains")) timed = true;
            return this.resolve(path);
          })
        : null;
      // spell is null when the character does not know it (level or talents); the action is skipped.
      return { name: a.action, spell: ch.abilities.get(a.action) ?? null, cond, timed, pet: a.pet ?? null };
    });
    for (const name of ch.config.rotation.precombat) {
      if (!this.actionNames.has(name)) throw new Error(`precombat: unknown action "${name}"`);
    }
  }

  // Every rank's id for a snake_case spell name.
  idsOf(name: string): number[] {
    return this.spellIds.get(name) ?? [];
  }

  private f(): Fight {
    return this.fight!;
  }

  private resolve(path: string[]): Getter {
    const [head, name, field] = path;
    const needSpellName = () => {
      if (!name || !this.spellIds.has(name)) throw new Error(`rotation: unknown spell "${name}" in ${path.join(".")}`);
    };
    // Cooldowns and cast counts belong to actions, which include consumables named after their item.
    // The spell is undefined when the character does not know the action.
    const actionSpell = () => {
      if (!name || !this.actionNames.has(name)) throw new Error(`rotation: unknown action "${name}" in ${path.join(".")}`);
      return this.ch.abilities.get(name);
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
        return () => this.f().calc.rangedHaste();
      case "auto_shot":
        if (name === "remains") return () => sec(this.f().autoShotFiresAt() - this.f().now);
        if (name === "windup") return () => (this.f().auto.windup ? 1 : 0);
        break;
      case "cooldown": {
        const spell = actionSpell();
        if (field === "ready") return () => (spell && this.f().cooldownReadyAt(spell) <= this.f().now ? 1 : 0);
        if (field === "remains") return () => (spell ? sec(this.f().cooldownReadyAt(spell) - this.f().now) : 1e9);
        break;
      }
      case "casts": {
        // Times cast so far this fight, for fixed patterns: (casts.a + casts.b) % 3 < 2.
        if (field !== undefined) break;
        const spell = actionSpell();
        return () => (spell ? this.f().castCount(spell) : 0);
      }
      case "cast": {
        const spell = actionSpell();
        if (field === "time") return () => (spell ? this.f().calc.castTime(spell) / 1000 : 0);
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
