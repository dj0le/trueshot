// Runs many fights for one setup and summarizes them.
import { buildCharacter } from "./character";
import { SimConfig, type SimConfigInput } from "./config";
import { Stream } from "./rng";
import { Rotation } from "./rotation";
import { Fight, type GameData, unknownPassiveAuras } from "./sim";

export type AbilitySummary = {
  name: string;
  dps: number;
  share: number;
  castsPerFight: number;
  ticksPerFight: number;
  critPct: number;
  missPct: number;
  avgHit: number;
};

export type SimResult = {
  name: string;
  iterations: number;
  dps: { mean: number; stdDev: number; min: number; max: number; error95: number };
  // DPS of each fight, in seed order, for paired comparisons.
  samples: number[];
  abilities: AbilitySummary[];
  manaSpentPerFight: number;
  // Average mana left unused at the end, as a share of the mana bar.
  manaLeftPct: number;
  oomPct: number;
  // Effects and auras the setup used that the engine does not implement yet.
  unimplemented: string[];
};

// Mean, sample standard deviation, and the 95% half-width of the mean.
function summarize(xs: number[]): { mean: number; stdDev: number; error95: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const stdDev = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, n - 1));
  return { mean, stdDev, error95: (1.96 * stdDev) / Math.sqrt(n) };
}

export function simulate(game: GameData, input: SimConfigInput): SimResult {
  const config = SimConfig.parse(input);
  const ch = buildCharacter(game.data, game.overrides, game.items, game.enchants, config);
  const rotation = new Rotation(ch, game);
  const unimplemented = new Set<string>();
  const { durationSec, durationVariancePct, iterations, seed } = config.fight;
  const lengths = new Stream(`${seed}/fight-length`);

  const dps: number[] = [];
  const totals = new Map<string, { damage: number; casts: number; hits: number; crits: number; misses: number; ticks: number }>();
  let totalMs = 0;
  let manaSpent = 0;
  let manaLeft = 0;
  let oomMs = 0;

  for (let i = 0; i < iterations; i++) {
    const spread = durationVariancePct / 100;
    const ms = durationSec * 1000 * (1 + lengths.range(-spread, spread));
    const r = new Fight(ch, game, rotation, ms, `${seed}/${i}`, unimplemented).run();
    dps.push(r.damage / (ms / 1000));
    totalMs += ms;
    manaSpent += r.manaSpent;
    manaLeft += r.manaLeft;
    oomMs += r.oomMs;
    for (const a of r.abilities) {
      const t = totals.get(a.name) ?? { damage: 0, casts: 0, hits: 0, crits: 0, misses: 0, ticks: 0 };
      t.damage += a.damage;
      t.casts += a.casts;
      t.hits += a.hits;
      t.crits += a.crits;
      t.misses += a.misses;
      t.ticks += a.ticks;
      totals.set(a.name, t);
    }
  }

  const { mean, stdDev, error95 } = summarize(dps);
  const totalDamage = [...totals.values()].reduce((a, t) => a + t.damage, 0);

  const abilities = [...totals.entries()]
    .map(([name, t]) => {
      const attempts = t.hits + t.crits + t.misses;
      return {
        name,
        dps: t.damage / (totalMs / 1000),
        share: totalDamage ? t.damage / totalDamage : 0,
        castsPerFight: t.casts / iterations,
        ticksPerFight: t.ticks / iterations,
        critPct: t.hits + t.crits ? (100 * t.crits) / (t.hits + t.crits) : 0,
        missPct: attempts ? (100 * t.misses) / attempts : 0,
        avgHit: t.hits + t.crits ? t.damage / (t.hits + t.crits) : 0,
      };
    })
    .sort((a, b) => b.dps - a.dps);

  return {
    name: config.name,
    iterations,
    // A loop, not Math.min(...dps): spreading tens of thousands of arguments overflows the stack.
    dps: { mean, stdDev, min: dps.reduce((a, b) => Math.min(a, b)), max: dps.reduce((a, b) => Math.max(a, b)), error95 },
    samples: dps,
    abilities,
    manaSpentPerFight: manaSpent / iterations,
    manaLeftPct: (100 * manaLeft) / iterations / ch.maxMana,
    oomPct: (100 * oomMs) / totalMs,
    unimplemented: [...new Set([...ch.gearNotes, ...unknownPassiveAuras(ch), ...unimplemented])].sort(),
  };
}

// Difference b - a, fight by fight. Both setups must use the same seed and iteration count, so
// each pair of fights shares its length and its rolls; the noise in the difference is then far
// smaller than either result's own spread.
export function compareResults(a: SimResult, b: SimResult): { delta: number; error95: number; pct: number } {
  if (a.samples.length !== b.samples.length) throw new Error("compare: setups ran a different number of fights");
  const { mean: delta, error95 } = summarize(a.samples.map((x, i) => b.samples[i]! - x));
  return { delta, error95, pct: (100 * delta) / a.dps.mean };
}

export type ActionValue = { action: string; condition: string | undefined; delta: number; error95: number; pct: number };

// What each rotation action is worth: DPS lost when that one action is removed, from paired runs.
// Negative means the rotation does better without it.
export function actionValues(game: GameData, input: SimConfigInput): ActionValue[] {
  const base = simulate(game, input);
  const actions = input.rotation.actions;
  return actions
    .map((a, i) => {
      const without = simulate(game, { ...input, rotation: { ...input.rotation, actions: actions.filter((_, j) => j !== i) } });
      const c = compareResults(without, base);
      return { action: a.action, condition: a.if, delta: c.delta, error95: c.error95, pct: (100 * c.delta) / without.dps.mean };
    })
    .sort((a, b) => b.delta - a.delta);
}

export type StatWeight = { stat: string; step: number; dpsPerPoint: number; error95: number; relative: number };

// DPS gained per point of each stat, from paired runs with that stat raised by `step`.
// relative is the weight against ranged attack power (1 RAP = 1.0).
export function statWeights(game: GameData, input: SimConfigInput, steps: Record<string, number>): StatWeight[] {
  const base = simulate(game, input);
  const weights = Object.entries(steps).map(([stat, step]) => {
    const stats = { ...input.gear.stats, [stat]: ((input.gear.stats as Record<string, number> | undefined)?.[stat] ?? 0) + step };
    const bumped = simulate(game, { ...input, gear: { ...input.gear, stats } });
    const c = compareResults(base, bumped);
    return { stat, step, dpsPerPoint: c.delta / step, error95: c.error95 / step, relative: 0 };
  });
  const rap = weights.find((w) => w.stat === "rangedAttackPower")?.dpsPerPoint;
  for (const w of weights) w.relative = rap ? w.dpsPerPoint / rap : 0;
  return weights.sort((a, b) => b.relative - a.relative);
}
