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
};

export const ON_LAND: Record<string, (ctx: ScriptContext) => void> = {
  // "Afflicting a target with Serpent Sting allows 50% of your Mana Regeneration to continue
  // while casting for 15 sec." The 100% upgrade needs Rapid Killing's kill reset, which a single
  // target fight never triggers.
  "Serpent Sting": (ctx) => {
    const pct = talentValue(ctx.data, ctx.config, "Rapid Recuperation", 0);
    if (pct > 0) ctx.applySpell(1242512, { 0: pct });
  },
};
