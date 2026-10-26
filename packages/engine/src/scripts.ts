// Talents whose client data is a dummy aura: their behaviour is written here by hand, from the
// tooltip. Keyed by the spell that sets them off when it lands.
import type { HunterData } from "@hunter-sim/data";
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
};

export const ON_LAND: Record<string, (ctx: ScriptContext) => void> = {
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
