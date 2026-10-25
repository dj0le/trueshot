// Runs many fights for one setup and summarizes them.
import { buildCharacter } from "./character";
import { SimConfig, type SimConfigInput } from "./config";
import { Stream } from "./rng";
import { Fight, type GameData, Rotation } from "./sim";

export type AbilitySummary = {
  name: string;
  dps: number;
  share: number;
  castsPerFight: number;
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
  oomPct: number;
  // Effects and auras the setup used that the engine does not implement yet.
  unimplemented: string[];
};

export function simulate(game: GameData, input: SimConfigInput): SimResult {
  const config = SimConfig.parse(input);
  const ch = buildCharacter(game.data, game.overrides, game.items, config);
  const rotation = new Rotation(ch, game);
  const unimplemented = new Set<string>();
  const { durationSec, durationVariancePct, iterations, seed } = config.fight;
  const lengths = new Stream(`${seed}/fight-length`);

  const dps: number[] = [];
  const totals = new Map<string, { damage: number; casts: number; hits: number; crits: number; misses: number }>();
  let totalMs = 0;
  let manaSpent = 0;
  let oomMs = 0;

  for (let i = 0; i < iterations; i++) {
    const spread = durationVariancePct / 100;
    const ms = durationSec * 1000 * (1 + lengths.range(-spread, spread));
    const r = new Fight(ch, game, rotation, ms, `${seed}/${i}`, unimplemented).run();
    dps.push(r.damage / (ms / 1000));
    totalMs += ms;
    manaSpent += r.manaSpent;
    oomMs += r.oomMs;
    for (const a of r.abilities) {
      const t = totals.get(a.name) ?? { damage: 0, casts: 0, hits: 0, crits: 0, misses: 0 };
      t.damage += a.damage;
      t.casts += a.casts;
      t.hits += a.hits;
      t.crits += a.crits;
      t.misses += a.misses;
      totals.set(a.name, t);
    }
  }

  const mean = dps.reduce((a, b) => a + b, 0) / iterations;
  const variance = dps.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, iterations - 1);
  const stdDev = Math.sqrt(variance);
  const totalDamage = [...totals.values()].reduce((a, t) => a + t.damage, 0);

  const abilities = [...totals.entries()]
    .map(([name, t]) => {
      const attempts = t.hits + t.crits + t.misses;
      return {
        name,
        dps: t.damage / (totalMs / 1000),
        share: totalDamage ? t.damage / totalDamage : 0,
        castsPerFight: t.casts / iterations,
        critPct: t.hits + t.crits ? (100 * t.crits) / (t.hits + t.crits) : 0,
        missPct: attempts ? (100 * t.misses) / attempts : 0,
        avgHit: t.hits + t.crits ? t.damage / (t.hits + t.crits) : 0,
      };
    })
    .sort((a, b) => b.dps - a.dps);

  return {
    name: config.name,
    iterations,
    dps: { mean, stdDev, min: Math.min(...dps), max: Math.max(...dps), error95: (1.96 * stdDev) / Math.sqrt(iterations) },
    samples: dps,
    abilities,
    manaSpentPerFight: manaSpent / iterations,
    oomPct: (100 * oomMs) / totalMs,
    unimplemented: [...new Set([...ch.gearNotes, ...unimplemented])].sort(),
  };
}

// Difference b - a, fight by fight. Both setups must use the same seed and iteration count, so
// each pair of fights shares its length and its rolls; the noise in the difference is then far
// smaller than either result's own spread.
export function compareResults(a: SimResult, b: SimResult): { delta: number; error95: number; pct: number } {
  if (a.samples.length !== b.samples.length) throw new Error("compare: setups ran a different number of fights");
  const diffs = a.samples.map((x, i) => b.samples[i]! - x);
  const n = diffs.length;
  const delta = diffs.reduce((s, d) => s + d, 0) / n;
  const sd = Math.sqrt(diffs.reduce((s, d) => s + (d - delta) ** 2, 0) / Math.max(1, n - 1));
  return { delta, error95: (1.96 * sd) / Math.sqrt(n), pct: (100 * delta) / a.dps.mean };
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
