// Talents whose client data is a dummy aura: their behaviour is written here by hand, from the
// tooltip. Keyed by the spell that sets them off when it lands.
import type { HunterData, Spell } from "@trueshot/data";
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

type OnLand = (ctx: ScriptContext, landed: Landed) => void;
type ProcIf = (ctx: ScriptContext) => boolean;

// Scripts on spellbook abilities, which reach every rank.
const ABILITY_ON_LAND: Record<string, OnLand> = {
  // "Your Mongoose Bite also causes the target to Bleed for damage equal to 40% of the damage done by
  // Mongoose Bite over 21 sec." The bleed spell's tick is set by the server; here it is that share.
  "Mongoose Bite": (ctx, landed) => {
    const pct = talentValue(ctx.data, ctx.config, "Lacerating Strikes", 0);
    if (pct > 0 && landed.damage > 0) ctx.bleed(1310536, (landed.damage * pct) / 100);
  },
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

// Scripts on other spells, by id.
const SPELL_ON_LAND: Record<number, OnLand> = {
  // Refocus (Renataki's Charm of Beasts), a dummy: "Instantly clears the cooldowns of Aimed Shot,
  // Multishot, Volley, and Arcane Shot."
  24531: (ctx) => ctx.resetCooldowns(["aimed_shot", "multi_shot", "volley", "arcane_shot"]),
};

// Procs that only fire under a condition their tooltip states and the client data does not carry,
// by talent.
const TALENT_PROC_IF: Record<string, ProcIf> = {
  // "Grants your melee and ranged attacks against enemies afflicted by Hunter's Mark a 10% chance".
  "Expose Prey": (ctx) => ctx.targetHas("hunters_mark"),
};

export type Scripts = {
  onLand: Map<number, OnLand>;
  procIf: Map<number, ProcIf>;
  // Every rank of an ability, by name.
  ranks(ability: string): Set<number>;
};

const cache = new WeakMap<HunterData, Scripts>();

// The scripts keyed by spell id, built once per data set.
export function scriptsFor(data: HunterData): Scripts {
  let scripts = cache.get(data);
  if (scripts) return scripts;
  const ranks = (ability: string) => new Set(data.abilities.find((a) => a.name === ability)?.ranks.map((r) => r.spellId) ?? []);
  const onLand = new Map<number, OnLand>(Object.entries(SPELL_ON_LAND).map(([id, f]) => [Number(id), f]));
  for (const [name, f] of Object.entries(ABILITY_ON_LAND)) {
    const ids = ranks(name);
    if (ids.size === 0) throw new Error(`scripts: no ability named ${name}`);
    for (const id of ids) onLand.set(id, f);
  }
  const procIf = new Map<number, ProcIf>();
  for (const [name, f] of Object.entries(TALENT_PROC_IF)) {
    const talent = data.talents.find((t) => t.name === name);
    if (!talent) throw new Error(`scripts: no talent named ${name}`);
    procIf.set(talent.spellId, f);
  }
  cache.set(data, (scripts = { onLand, procIf, ranks }));
  return scripts;
}
