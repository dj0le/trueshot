// Searches for a better priority list by trying variations of it.
//
// A rotation is a list of genes: an action, whether it is used, and up to two condition terms
// joined with &. Each round mutates the best list several ways and keeps a mutant only when it
// beats the best by more than the noise. Every candidate runs on the same fights (same seed),
// so comparisons are paired and cheap. The winner is then re-checked on fresh fights, because a
// search can overfit to the exact fights it was scored on.
import { snake } from "./character";
import type { ActionConfig, SimConfigInput } from "./config";
import { Stream } from "./rng";
import { compareResults, simulate, type SimResult } from "./run";
import type { GameData } from "./sim";

export type Term =
  | { kind: "manaAbove"; pct: number }
  | { kind: "fightRemainsAbove"; sec: number }
  // Only start a cast that ends before the next Auto Shot would fire.
  | { kind: "noClip" }
  // Only when the action's own DoT is not on the target.
  | { kind: "dotDown" };

export type Gene = { action: string; enabled: boolean; terms: Term[] };

export function termToExpr(action: string, t: Term): string {
  switch (t.kind) {
    case "manaAbove":
      return `mana.pct > ${t.pct}`;
    case "fightRemainsAbove":
      return `fight.remains > ${t.sec}`;
    case "noClip":
      return `auto_shot.remains >= cast.${action}.time`;
    case "dotDown":
      return `!dot.${action}.ticking`;
  }
}

export function genesToActions(genes: Gene[]): ActionConfig[] {
  return genes
    .filter((g) => g.enabled)
    .map((g) => (g.terms.length ? { action: g.action, if: g.terms.map((t) => termToExpr(g.action, t)).join(" & ") } : { action: g.action }));
}

const describe = (genes: Gene[]) =>
  genesToActions(genes)
    .map((a) => (a.if ? `${a.action} if ${a.if}` : a.action))
    .join(", ");

// Reads an existing rotation into genes, as far as it is expressible. Conditions the search does
// not know are dropped, which the caller is told about.
export function actionsToGenes(actions: ActionConfig[]): { genes: Gene[]; dropped: string[] } {
  const dropped: string[] = [];
  const genes = actions.map((a) => {
    const terms: Term[] = [];
    for (const part of (a.if ?? "").split("&").map((p) => p.trim()).filter(Boolean)) {
      let m: RegExpExecArray | null;
      if ((m = /^mana\.pct > (\d+)$/.exec(part))) terms.push({ kind: "manaAbove", pct: Number(m[1]) });
      else if ((m = /^fight\.remains > (\d+)$/.exec(part))) terms.push({ kind: "fightRemainsAbove", sec: Number(m[1]) });
      else if (part === `auto_shot.remains >= cast.${a.action}.time`) terms.push({ kind: "noClip" });
      else if (part === `!dot.${a.action}.ticking`) terms.push({ kind: "dotDown" });
      else dropped.push(`${a.action}: ${part}`);
    }
    return { action: a.action, enabled: true, terms };
  });
  return { genes, dropped };
}

export type OptimizeOptions = {
  // Extra actions the search may add, disabled at the start.
  pool: string[];
  // Fights per candidate during the search.
  iterations: number;
  // Candidates to try in total.
  budget: number;
  mutantsPerRound: number;
  // Fights for the final check on fresh seeds.
  confirmIterations: number;
  seed: string;
  onProgress?: (msg: string) => void;
};

export type OptimizeResult = {
  start: Gene[];
  best: Gene[];
  bestActions: ActionConfig[];
  evaluated: number;
  // On fresh fights: the original rotation, the winner, and the paired difference.
  confirm: { before: SimResult; after: SimResult; delta: number; error95: number; pct: number };
};

function mutate(genes: Gene[], rng: Stream, castActions: Set<string>, dotActions: Set<string>): Gene[] {
  const g: Gene[] = structuredClone(genes);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng.next() * xs.length)]!;
  const i = Math.floor(rng.next() * g.length);
  const gene = g[i]!;

  switch (pick(["swap", "swap", "toggle", "addTerm", "dropTerm", "tune", "tune"])) {
    case "swap": {
      const j = Math.floor(rng.next() * g.length);
      [g[i], g[j]] = [g[j]!, g[i]!];
      break;
    }
    case "toggle":
      gene.enabled = !gene.enabled;
      break;
    case "addTerm": {
      if (gene.terms.length >= 2) break;
      const options: Term[] = [
        { kind: "manaAbove", pct: pick([10, 20, 30, 40, 50, 60, 70, 80]) },
        { kind: "fightRemainsAbove", sec: pick([3, 6, 9, 12, 15]) },
      ];
      if (castActions.has(gene.action)) options.push({ kind: "noClip" });
      if (dotActions.has(gene.action)) options.push({ kind: "dotDown" });
      const term = pick(options);
      if (!gene.terms.some((t) => t.kind === term.kind)) gene.terms.push(term);
      break;
    }
    case "dropTerm":
      if (gene.terms.length) gene.terms.splice(Math.floor(rng.next() * gene.terms.length), 1);
      break;
    case "tune": {
      const t = gene.terms.find((x) => x.kind === "manaAbove" || x.kind === "fightRemainsAbove");
      if (t?.kind === "manaAbove") t.pct = Math.min(95, Math.max(5, t.pct + pick([-10, -5, 5, 10])));
      if (t?.kind === "fightRemainsAbove") t.sec = Math.max(1, t.sec + pick([-3, -1, 1, 3]));
      break;
    }
  }
  return g;
}

export function optimize(game: GameData, config: SimConfigInput, opts: OptimizeOptions): OptimizeResult {
  const log = opts.onProgress ?? (() => {});
  const run = (genes: Gene[], iterations: number, seed: string) =>
    simulate(game, {
      ...config,
      rotation: { ...config.rotation, actions: genesToActions(genes) },
      fight: { ...config.fight, iterations, seed },
    });

  const { genes: fromConfig, dropped } = actionsToGenes(config.rotation.actions);
  for (const d of dropped) log(`note: condition not searchable, dropped: ${d}`);
  const present = new Set(fromConfig.map((g) => g.action));
  const start = [
    ...fromConfig,
    ...opts.pool.filter((a) => !present.has(a)).map((action) => ({ action, enabled: false, terms: [] })),
  ];

  // Which actions have a cast time worth not clipping, or a DoT worth not reapplying.
  const castActions = new Set<string>();
  const dotActions = new Set<string>();
  for (const a of game.data.abilities) {
    const top = game.data.spells[String(a.ranks.at(-1)!.spellId)]!;
    if (top.castTimeMs > 0) castActions.add(snake(a.name));
    if (top.effects.some((e) => e.aura === 3)) dotActions.add(snake(a.name));
  }

  const rng = new Stream(`${opts.seed}/mutations`);
  const searchSeed = `${opts.seed}/search`;
  let best = start;
  let bestResult = run(best, opts.iterations, searchSeed);
  let evaluated = 1;
  log(`start ${bestResult.dps.mean.toFixed(1)} DPS: ${describe(best)}`);

  const seen = new Set([JSON.stringify(genesToActions(best))]);
  // Mutants already tried do not count against the budget, so cap the attempts too.
  let attempts = 0;
  while (evaluated < opts.budget && attempts < opts.budget * 20) {
    let roundBest: { genes: Gene[]; result: SimResult; delta: number } | null = null;
    for (let m = 0; m < opts.mutantsPerRound && evaluated < opts.budget; m++, attempts++) {
      // Sometimes stack two mutations to step over a dip.
      let candidate = mutate(best, rng, castActions, dotActions);
      if (rng.next() < 0.3) candidate = mutate(candidate, rng, castActions, dotActions);
      const key = JSON.stringify(genesToActions(candidate));
      if (seen.has(key) || genesToActions(candidate).length === 0) continue;
      seen.add(key);
      const result = run(candidate, opts.iterations, searchSeed);
      evaluated++;
      const c = compareResults(bestResult, result);
      if (c.delta > c.error95 && (!roundBest || c.delta > roundBest.delta)) roundBest = { genes: candidate, result, delta: c.delta };
    }
    if (roundBest) {
      best = roundBest.genes;
      bestResult = roundBest.result;
      log(`[${evaluated}] ${bestResult.dps.mean.toFixed(1)} DPS (+${roundBest.delta.toFixed(1)}): ${describe(best)}`);
    }
  }

  const confirmSeed = `${opts.seed}/confirm`;
  const before = run(start, opts.confirmIterations, confirmSeed);
  const after = run(best, opts.confirmIterations, confirmSeed);
  const c = compareResults(before, after);
  return { start, best, bestActions: genesToActions(best), evaluated, confirm: { before, after, ...c } };
}
