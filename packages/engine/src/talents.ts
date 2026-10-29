// Searches for the talents and pet that do the most damage with a given gear set and rotation.
//
// A build is a talent allocation and a pet (a family, or none). The search starts from seeds: the
// config's talents with every pet, then, for every pair of trees, a greedy build deep in one with
// the rest in the other, with the best pet and with none. The best few seeds are then climbed by
// moving points between talents and swapping the pet, keeping a move only when paired fights put
// it ahead by more than the noise. Builds that break the talent rules are skipped without a fight.
//
// With a spec (a tree name), only builds with more points in that tree than in any other count; a
// config outside the spec starts from a greedy build deep in it instead of its own talents.
//
// Talents and rotation depend on each other (a build short on mana wants a thriftier rotation), so
// optimizeBuild alternates: the rotation for the config's build, then the build with that rotation
// fixed, then the rotation for the new build, until the build stops changing.
import type { HunterData, Talent } from "@trueshot/data";
import { talentErrors, talentPoints } from "./character";
import { SimConfig, type SimConfigInput } from "./config";
import { optimize, type OptimizeOptions } from "./optimize";
import { Stream } from "./rng";
import { compareResults, simulate, type SimResult } from "./run";
import type { GameData } from "./sim";

// How the hunter plays: where from, and when weaving, how far a weave may push Auto Shot back.
export type Style = { position: SimConfig["position"]; weaveDelayMs: number };

// pet: a family name, or null for no pet.
export type Build = { talents: Record<string, number>; pet: string | null; style: Style };

// Play styles a search tries: shooting, melee, and weaving with a range of Auto Shot delays (the
// best delay depends on the build: about 0.5 sec for ranged builds, 1.2 sec or more for Survival).
const STYLES: Style[] = [
  { position: "ranged", weaveDelayMs: 0 },
  { position: "melee", weaveDelayMs: 0 },
  ...[300, 600, 900, 1200, 1500, 2000].map((weaveDelayMs) => ({ position: "weave" as const, weaveDelayMs })),
];
// The weave delay matters only when weaving.
const styleKey = (s: Style) => `${s.position}:${s.position === "weave" ? s.weaveDelayMs : 0}`;
const sameStyle = (a: Style, b: Style) => styleKey(a) === styleKey(b);

export type BuildSearchOptions = {
  // Fights per candidate.
  iterations: number;
  // Builds to fight in total, seeds included.
  budget: number;
  mutantsPerRound: number;
  // How many of the best seeds are climbed; the budget left after the seeds is split between them.
  climbs: number;
  // Start from the config's build alone, without the generated seeds.
  configOnly: boolean;
  // Whether the pet (any family, or none) is searched too.
  pets: boolean;
  // Whether the play style (ranged, melee, weaving) is searched too; it needs a melee weapon.
  styles: boolean;
  // A talent tree the build must spend the most points in.
  spec?: string | undefined;
  seed: string;
  onProgress?: (msg: string) => void;
  // Scores a candidate config, our own sim by default; another sim can stand in (wowsims). It may
  // throw when the setup cannot run, which skips the candidate.
  evaluate?: (config: SimConfigInput) => SimResult;
};

export type BuildSearchResult = { best: Build; result: SimResult; evaluated: number };

export function configBuild(config: SimConfigInput): Build {
  const c = SimConfig.parse(config);
  return {
    talents: Object.fromEntries(Object.entries(c.talents).filter(([, rank]) => rank > 0)),
    pet: c.pet.active ? c.pet.family : null,
    style: { position: c.position, weaveDelayMs: c.weave.maxAutoShotDelayMs },
  };
}

// The config with a build in place. A different family drops the config's pet ability list, which
// names the old family's abilities.
export function withBuild(config: SimConfigInput, b: Build): SimConfigInput {
  const pet = SimConfig.parse(config).pet;
  const styled = {
    ...config,
    talents: b.talents,
    position: b.style.position,
    weave: { ...config.weave, maxAutoShotDelayMs: b.style.weaveDelayMs },
  };
  if (!b.pet) return { ...styled, pet: { ...config.pet, active: false } };
  const abilities = b.pet === pet.family ? config.pet?.abilities : undefined;
  return { ...styled, pet: { ...config.pet, active: true, family: b.pet, abilities } };
}

export function describeStyle(s: Style): string {
  return s.position === "weave" ? `weaving (Auto Shot pushed back up to ${(s.weaveDelayMs / 1000).toFixed(1)} sec)` : s.position;
}

// "Beast Mastery 31 / Marksmanship 20, Cat, ranged"
export function describeBuild(data: HunterData, b: Build): string {
  const split = [...treePoints(data, b.talents)].map(([tree, n]) => `${tree} ${n}`).join(" / ");
  return `${split}, ${b.pet ?? "no pet"}, ${describeStyle(b.style)}`;
}

const SPECS: Record<string, string> = { bm: "Beast Mastery", mm: "Marksmanship", sv: "Survival" };

// A spec option's tree: a short name (bm, mm, sv) or the tree's own name.
export function specTree(spec: string | undefined): string | undefined {
  return spec && (SPECS[spec.toLowerCase()] ?? spec);
}

// Points per tree.

export function treePoints(data: HunterData, talents: Record<string, number>): Map<string, number> {
  const trees = new Map<string, number>();
  for (const t of data.talents) trees.set(t.tree, (trees.get(t.tree) ?? 0) + (talents[t.name] ?? 0));
  return trees;
}

// The tree with more points than any other, or null on a tie.
export function specOf(data: HunterData, talents: Record<string, number>): string | null {
  const sorted = [...treePoints(data, talents)].sort((a, b) => b[1] - a[1]);
  return sorted[0] && sorted[0][1] > (sorted[1]?.[1] ?? 0) ? sorted[0][0] : null;
}

// Spends points down a talent order, each talent to its max before the next, and comes back to
// talents whose row or prerequisite was out of reach on the way.
export function fillBuild(data: HunterData, level: number, order: Talent[]): Record<string, number> {
  const talents: Record<string, number> = {};
  const available = talentPoints(level);
  let spent = 0;
  for (let progress = true; progress && spent < available; ) {
    progress = false;
    for (const t of order) {
      while (spent < available && (talents[t.name] ?? 0) < t.maxRank) {
        talents[t.name] = (talents[t.name] ?? 0) + 1;
        if (talentErrors(data, level, talents).errors.length === 0) {
          spent++;
          progress = true;
          continue;
        }
        if (--talents[t.name]! === 0) delete talents[t.name];
        break;
      }
    }
  }
  return talents;
}

const inTree = (data: HunterData, tree: string) => data.talents.filter((t) => t.tree === tree).sort((a, b) => a.row - b.row || a.col - b.col);

// Deep in one tree, the rest in another, for every ordered pair of trees (deep in the spec only, with one).
function seedBuilds(data: HunterData, level: number, pet: string | null, style: Style, spec?: string): { name: string; build: Build }[] {
  const trees = [...new Set(data.talents.map((t) => t.tree))];
  return trees.filter((a) => !spec || a === spec).flatMap((a) =>
    trees
      .filter((b) => b !== a)
      .map((b) => ({ name: `deep ${a}, then ${b}`, build: { talents: fillBuild(data, level, [...inTree(data, a), ...inTree(data, b)]), pet, style } })),
  );
}

const talentKey = (b: Build) =>
  JSON.stringify(
    Object.entries(b.talents)
      .filter(([, r]) => r > 0)
      .sort(),
  );
const keyOf = (b: Build) => JSON.stringify([talentKey(b), b.pet, styleKey(b.style)]);

function mutate(b: Build, rng: Stream, data: HunterData, level: number, families: string[] | null, styles: Style[] | null): Build {
  if (families && rng.next() < 0.15) return { ...b, pet: rng.pick([null, ...families.filter((f) => f !== b.pet)]) };
  if (styles && rng.next() < 0.1) return { ...b, style: rng.pick(styles.filter((s) => !sameStyle(s, b.style))) };
  const talents = { ...b.talents };
  const rank = (name: string) => talents[name] ?? 0;
  const spare = talentPoints(level) - Object.values(talents).reduce((s, r) => s + r, 0);
  const to = rng.pick(data.talents.filter((t) => rank(t.name) < t.maxRank));
  if (!to) return b;
  const room = to.maxRank - rank(to.name);
  const taken = Object.keys(talents).filter((n) => n !== to.name && rank(n) > 0);
  if (spare > 0 && (taken.length === 0 || rng.next() < 0.5)) {
    talents[to.name] = rank(to.name) + Math.min(spare, rng.pick([1, room]));
    return { ...b, talents };
  }
  if (taken.length === 0) return b;
  const from = rng.pick(taken);
  // Mostly one point at a time, sometimes the whole talent.
  const n = rng.pick([1, 1, Math.min(rank(from), room)]);
  talents[from] = rank(from) - n;
  if (talents[from] === 0) delete talents[from];
  talents[to.name] = rank(to.name) + n;
  return { ...b, talents };
}

export function searchBuilds(game: GameData, config: SimConfigInput, opts: BuildSearchOptions): BuildSearchResult {
  const log = opts.onProgress ?? (() => {});
  const data = game.data;
  const parsed = SimConfig.parse(config);
  const level = parsed.level;
  if (opts.spec && !data.talents.some((t) => t.tree === opts.spec)) throw new Error(`build search: no talent tree named ${opts.spec}`);
  const families = opts.pets ? data.petFamilies.map((f) => f.name) : null;
  const styles = opts.styles && parsed.gear.items.mainHand ? STYLES : null;
  const searchSeed = `${opts.seed}/search`;
  const evaluate = opts.evaluate ?? ((c: SimConfigInput) => simulate(game, c));
  const seen = new Map<string, SimResult | null>();
  let evaluated = 0;

  // null: the build breaks the talent rules, or the setup cannot run with it.
  const run = (b: Build): SimResult | null => {
    const key = keyOf(b);
    if (seen.has(key)) return seen.get(key)!;
    let result: SimResult | null = null;
    if (talentErrors(data, level, b.talents).errors.length === 0 && (!opts.spec || specOf(data, b.talents) === opts.spec)) {
      try {
        result = evaluate({ ...withBuild(config, b), fight: { ...config.fight, iterations: opts.iterations, seed: searchSeed } });
        evaluated++;
      } catch {
        result = null;
      }
    }
    seen.set(key, result);
    return result;
  };

  type Seed = { name: string; build: Build; result: SimResult };
  const tryAll = (candidates: { name: string; build: Build }[]): Seed[] => {
    const out: Seed[] = [];
    const keys = new Set<string>();
    for (const c of candidates) {
      const key = keyOf(c.build);
      if (keys.has(key)) continue;
      keys.add(key);
      const result = run(c.build);
      if (result) out.push({ ...c, result });
    }
    return out;
  };

  // The play style and the pet mostly stand apart from the talents, so each is chosen once on the
  // config's talents: the style first, then the pet with it.
  const own = configBuild(config);
  const start = !opts.spec || specOf(data, own.talents) === opts.spec ? own : { ...own, talents: specStart(data, level, own.talents, opts.spec) };
  const byDps = (a: Seed, b: Seed) => b.result.dps.mean - a.result.dps.mean;
  const withStyles = tryAll((styles ?? [start.style]).map((style) => ({ name: `config, ${describeStyle(style)}`, build: { ...start, style } })));
  const bestStyle = withStyles.sort(byDps)[0]?.build.style ?? start.style;
  const pets = families ? [start.pet, ...families, null] : [start.pet];
  const withPets = tryAll(pets.map((pet) => ({ name: `config, ${pet ?? "no pet"}`, build: { ...start, pet, style: bestStyle } })));
  const bestPet = withPets.filter((s) => s.build.pet).sort(byDps)[0]?.build.pet ?? start.pet;
  const generated = opts.configOnly
    ? []
    : [...new Set([bestPet, ...(families ? [null] : [])])].flatMap((pet) => seedBuilds(data, level, pet, bestStyle, opts.spec));
  const seeds = [...withStyles, ...withPets, ...tryAll(generated)].sort(byDps);
  if (seeds.length === 0) throw new Error("build search: no seed build can run; check the config's talents");
  for (const s of seeds.slice(0, 8)) log(`seed ${s.result.dps.mean.toFixed(1)} DPS: ${s.name} (${describeBuild(data, s.build)})`);

  const rng = new Stream(`${opts.seed}/mutations`);
  // One climb per talent build: the same talents with another pet or style are the same climb.
  const climbs = seeds.filter((s, i) => seeds.findIndex((x) => talentKey(x.build) === talentKey(s.build)) === i).slice(0, opts.climbs);
  const perClimb = Math.max(0, Math.floor((opts.budget - evaluated) / climbs.length));
  let best = { build: climbs[0]!.build, result: climbs[0]!.result };
  for (const seed of climbs) {
    let current = { build: seed.build, result: seed.result };
    const stopAt = evaluated + perClimb;
    log(`climbing from ${seed.name}`);
    // Repeats and invalid builds cost no fights, so cap the attempts too.
    for (let attempts = 0; evaluated < stopAt && attempts < perClimb * 50; ) {
      let roundBest: { build: Build; result: SimResult; delta: number } | null = null;
      for (let m = 0; m < opts.mutantsPerRound && evaluated < stopAt; m++, attempts++) {
        let candidate = mutate(current.build, rng, data, level, families, styles);
        // Sometimes two moves at once, to step over a dip (a row requirement, a prerequisite).
        if (rng.next() < 0.3) candidate = mutate(candidate, rng, data, level, families, styles);
        if (seen.has(keyOf(candidate))) continue;
        const result = run(candidate);
        if (!result) continue;
        const c = compareResults(current.result, result);
        if (c.delta > c.error95 && (!roundBest || c.delta > roundBest.delta)) roundBest = { build: candidate, result, delta: c.delta };
      }
      if (roundBest) {
        current = roundBest;
        log(`[${evaluated}] ${current.result.dps.mean.toFixed(1)} DPS (+${roundBest.delta.toFixed(1)}): ${describeBuild(data, current.build)}`);
      }
    }
    if (current.result.dps.mean > best.result.dps.mean) best = current;
  }
  return { best: best.build, result: best.result, evaluated };
}

// Deep in the spec, then in the tree the config spends the most in after it.
function specStart(data: HunterData, level: number, talents: Record<string, number>, spec: string): Record<string, number> {
  const next = [...treePoints(data, talents)].filter(([tree]) => tree !== spec).sort((a, b) => b[1] - a[1])[0]![0];
  return fillBuild(data, level, [...inTree(data, spec), ...inTree(data, next)]);
}

export type PetRow = { pet: string | null; dps: number; delta: number; error95: number };

// Every pet family, and no pet, with the config's talents and rotation, on the same fights.
// Families that cannot run the rotation (it sends an ability they lack) are left out.
export function petSweep(game: GameData, config: SimConfigInput): PetRow[] {
  const base = simulate(game, config);
  const own = configBuild(config);
  const rows: PetRow[] = [];
  for (const pet of [null, ...game.data.petFamilies.map((f) => f.name)]) {
    let r: SimResult;
    try {
      r = simulate(game, withBuild(config, { ...own, pet }));
    } catch {
      continue;
    }
    const c = compareResults(base, r);
    rows.push({ pet, dps: r.dps.mean, delta: c.delta, error95: c.error95 });
  }
  return rows.sort((a, b) => b.dps - a.dps);
}

// Abilities only some talents teach. A build search adds the missing ones to the rotation, so a
// build that gains one gets to use it; the rotation search then moves or drops them.
export type Taught = { precombat: string[]; actions: string[] };

function withTaught(config: SimConfigInput, taught: Taught): SimConfigInput {
  const r = config.rotation;
  const precombat = r.precombat ?? [];
  return {
    ...config,
    rotation: {
      precombat: [...precombat, ...taught.precombat.filter((a) => !precombat.includes(a))],
      actions: [...r.actions, ...taught.actions.filter((a) => !r.actions.some((x) => x.action === a)).map((action) => ({ action }))],
    },
  };
}

export type OptimizeBuildOptions = {
  build: Omit<BuildSearchOptions, "configOnly" | "seed" | "onProgress">;
  rotation: Omit<OptimizeOptions, "seed" | "onProgress">;
  // Build-then-rotation rounds at most; it stops early once the build stops changing.
  rounds: number;
  taught: Taught;
  // Fights for the final check on fresh seeds.
  confirmIterations: number;
  seed: string;
  onProgress?: (msg: string) => void;
};

export type OptimizeBuildResult = {
  best: SimConfigInput;
  build: Build;
  confirm: { before: SimResult; after: SimResult; delta: number; error95: number; pct: number };
};

export function optimizeBuild(game: GameData, config: SimConfigInput, opts: OptimizeBuildOptions): OptimizeBuildResult {
  const log = opts.onProgress ?? (() => {});
  const tuneRotation = (c: SimConfigInput, label: string): SimConfigInput => {
    log(`\nrotation for ${describeBuild(game.data, configBuild(c))}`);
    const r = optimize(game, c, { ...opts.rotation, seed: `${opts.seed}/rotation-${label}`, onProgress: log });
    return r.confirm.delta > r.confirm.error95 ? { ...c, rotation: { ...c.rotation, actions: r.bestActions } } : c;
  };
  let current = tuneRotation(withTaught(config, opts.taught), "start");
  for (let round = 0; round < opts.rounds; round++) {
    log(`\nround ${round + 1}: talents and pet`);
    const found = searchBuilds(game, current, { ...opts.build, configOnly: round > 0, seed: `${opts.seed}/build${round}`, onProgress: log });
    if (keyOf(found.best) === keyOf(configBuild(current))) break;
    current = tuneRotation(withBuild(current, found.best), String(round));
  }
  const fresh = { ...config.fight, iterations: opts.confirmIterations, seed: `${opts.seed}/confirm` };
  const before = simulate(game, { ...config, fight: fresh });
  const after = simulate(game, { ...current, fight: fresh });
  return { best: current, build: configBuild(current), confirm: { before, after, ...compareResults(before, after) } };
}
