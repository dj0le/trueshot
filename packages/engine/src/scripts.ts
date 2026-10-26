// Talents whose client data is a dummy aura: their behaviour is written here by hand, from the
// tooltip. Keyed by the spell that sets them off when it lands.
import type { HunterData, Spell } from "@hunter-sim/data";
import { talentValue } from "./character";
import type { SimConfig } from "./config";

export type ScriptContext = {
  data: HunterData;
  config: SimConfig;
  // Applies a spell's auras, optionally replacing effect values by index.
  applySpell(id: number, values?: Record<number, number>): void;
  summonHawk(): void;
  // Makes the named actions ready again.
  resetCooldowns(actions: string[]): void;
  // A bleed of `total` damage on the target over the spell's duration, as is: it carries damage
  // that was already done and modified.
  bleed(spellId: number, total: number): void;
  targetHas(spellName: string): boolean;
};

// What a landed spell did, for scripts that scale off it.
export type Landed = { spell: Spell; damage: number };

export const ON_LAND: Record<string, (ctx: ScriptContext, landed: Landed) => void> = {
  // "Your Mongoose Bite also causes the target to Bleed for damage equal to 40% of the damage done by
  // Mongoose Bite over 21 sec." The bleed spell's tick is set by the server; here it is that share.
  "Mongoose Bite": (ctx, landed) => {
    const pct = talentValue(ctx.data, ctx.config, "Lacerating Strikes", 0);
    if (pct > 0 && landed.damage > 0) ctx.bleed(1310536, (landed.damage * pct) / 100);
  },
  // Refocus, the trinket's dummy: "Instantly clears the cooldowns of Aimed Shot, Multishot, Volley,
  // and Arcane Shot." Keyed by the item's name, which on-use actions carry.
  "Renataki's Charm of Beasts": (ctx) => ctx.resetCooldowns(["aimed_shot", "multi_shot", "volley", "arcane_shot"]),
  // The dive is the spell's damage effect; the hawk it leaves behind is server-side.
  "Summon Hawk": (ctx) => ctx.summonHawk(),
  // "Afflicting a target with Serpent Sting allows 50% of your Mana Regeneration to continue
  // while casting for 15 sec." The 100% upgrade needs Rapid Killing's kill reset, which a single
  // target fight never triggers.
  "Serpent Sting": (ctx) => {
    const pct = talentValue(ctx.data, ctx.config, "Rapid Recuperation", 0);
    if (pct > 0) ctx.applySpell(1242512, { 0: pct });
  },
};

// Procs that only fire under a condition their tooltip states and the client data does not carry.
export const PROC_IF: Record<string, (ctx: ScriptContext) => boolean> = {
  // "Grants your melee and ranged attacks against enemies afflicted by Hunter's Mark a 10% chance".
  "Expose Prey": (ctx) => ctx.targetHas("hunters_mark"),
};
