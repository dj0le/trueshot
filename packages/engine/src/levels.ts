// The attack table against a target of another level: Classic's weapon skill rules, with skill at
// its cap (5 per level; Forever has no weapon skill racials) and defense 5 per target level.
import type { Overrides } from "@trueshot/data";

export type AttackTable = {
  missPct: number;
  // Magic attacks (the pet's Lightning Breath, Sonic Blast) miss on their own table.
  spellMissPct: number;
  // Hit from gear and talents below this much does nothing.
  hitPenaltyPct: number;
  // Taken off crit chance (negative against lower-level targets, which are easier to crit).
  critSuppressionPct: number;
  // Taken off crit from auras (talents, buffs, gear) only, so never more than that crit.
  auraCritSuppressionPct: number;
  // Melee only: ranged attacks cannot be dodged, and only white melee hits glance.
  dodgePct: number;
  glancingPct: number;
  glancingPenaltyPct: number;
};

export function attackTable(f: Overrides["formula"], attackerLevel: number, targetLevel: number): AttackTable {
  // Defense over weapon skill.
  const gap = 5 * (targetLevel - attackerLevel);
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  // vmangos SpellCaster::GetMeleeMissChance: 0.1% per point, 0.2% once the gap passes 10 (+3 = 8%).
  const missPct = clamp(gap <= 10 ? 5 + 0.1 * gap : 5 + 0.2 * gap, 0, 60);
  // Classic: crit against a higher target drops by a fixed amount per level; a lower target gives
  // 0.04% per point. Aura crit loses more against +3 and up (overrides.toml).
  const levels = targetLevel - attackerLevel;
  const critSuppressionPct = levels > 0 ? levels * f.critSuppressionPerLevelPct.value : 0.04 * gap;
  // Glancing: 10% plus 2% per point of defense over skill; damage between low and high, here the mean.
  const low = clamp(1.3 - 0.05 * gap, 0.01, 0.91);
  const high = clamp(1.2 - 0.03 * gap, 0.2, 0.99);
  // vmangos Unit::MagicSpellHitResult against a creature: 96% hit minus 1% per level up to +2, then
  // 11% per level (+3 = 83%), between 1% and 99%. Partial resists are not modelled.
  const spellHit = levels < 3 ? 96 - levels : 94 - (levels - 2) * 11;
  return {
    missPct,
    spellMissPct: 100 - clamp(spellHit, 1, 99),
    hitPenaltyPct: gap > 10 ? 1 : 0,
    critSuppressionPct,
    auraCritSuppressionPct: levels >= 3 ? f.auraCritSuppressionPct.value : 0,
    dodgePct: clamp(5 + 0.1 * gap, 0, 100),
    glancingPct: clamp(10 + 2 * gap, 0, 100),
    glancingPenaltyPct: 100 * (1 - (low + high) / 2),
  };
}
