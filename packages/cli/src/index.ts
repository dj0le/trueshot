// hunter-sim command line. Usage:
//   bun run sim run <config.toml> [--iterations N] [--seed S]
//   bun run sim compare <a.toml> <b.toml> [--iterations N] [--seed S]
//   bun run sim weights <config.toml> [--iterations N]
//   bun run sim optimize <config.toml> [--budget N] [--iterations N] [--pool a,b] [--out file.toml]
import { loadGameData, unconfirmed } from "@hunter-sim/data";
import { compareResults, optimize, simulate, statWeights, type ActionConfig, type SimConfigInput, type SimResult } from "@hunter-sim/engine";

const fmt = (n: number, digits = 1) => n.toFixed(digits);

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ")).join("\n");
}

function print(r: SimResult): void {
  console.log(`\n${r.name}`);
  console.log(
    `DPS ${fmt(r.dps.mean)} ± ${fmt(r.dps.error95)} (95%), sd ${fmt(r.dps.stdDev)}, range ${fmt(r.dps.min)} to ${fmt(r.dps.max)}, ${r.iterations} fights`,
  );
  console.log(`Mana spent per fight ${fmt(r.manaSpentPerFight, 0)}, out of mana ${fmt(r.oomPct)}% of the time\n`);
  console.log(
    table([
      ["Ability", "DPS", "Share", "Casts", "Crit%", "Miss%", "Avg hit"],
      ...r.abilities.map((a) => [
        a.name,
        fmt(a.dps),
        `${fmt(a.share * 100)}%`,
        fmt(a.castsPerFight),
        fmt(a.critPct),
        fmt(a.missPct),
        fmt(a.avgHit, 0),
      ]),
    ]),
  );
  if (r.unimplemented.length > 0) {
    console.log(`\nNot simulated yet (${r.unimplemented.length}):\n  ${r.unimplemented.join("\n  ")}`);
  }
}

async function loadConfig(path: string, flag: (name: string) => string | undefined): Promise<SimConfigInput> {
  const config = Bun.TOML.parse(await Bun.file(path).text()) as SimConfigInput;
  config.fight = { ...config.fight };
  if (flag("iterations")) config.fight.iterations = Number(flag("iterations"));
  if (flag("seed")) config.fight.seed = flag("seed")!;
  return config;
}

const USAGE = [
  "usage:",
  "  bun run sim run <config.toml> [--iterations N] [--seed S]",
  "  bun run sim compare <a.toml> <b.toml> [--iterations N] [--seed S]",
  "  bun run sim weights <config.toml> [--iterations N]",
  "  bun run sim optimize <config.toml> [--budget N] [--iterations N] [--pool a,b] [--out file.toml]",
].join("\n");

// Ranged actions the optimizer may add even when the starting rotation leaves them out.
const DEFAULT_POOL = ["rapid_fire", "serpent_sting", "aimed_shot", "sniper_shot", "multi_shot", "arcane_shot", "volley"];

function actionsToml(actions: ActionConfig[]): string {
  return actions
    .map((a) => `[[rotation.actions]]\naction = "${a.action}"${a.if ? `\nif = "${a.if}"` : ""}`)
    .join("\n\n");
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const paths = rest.filter((a, i) => !a.startsWith("--") && !rest[i - 1]?.startsWith("--"));
  const flag = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const game = await loadGameData();
  const started = performance.now();

  if (command === "run" && paths.length === 1) {
    print(simulate(game, await loadConfig(paths[0]!, flag)));
  } else if (command === "compare" && paths.length === 2) {
    const [a, b] = await Promise.all(paths.map((p) => loadConfig(p, flag)));
    // Paired fights need identical lengths and seeds, so b borrows a's fight settings.
    b!.fight = { ...a!.fight };
    const ra = simulate(game, a!);
    const rb = simulate(game, b!);
    print(ra);
    print(rb);
    const c = compareResults(ra, rb);
    const sign = c.delta >= 0 ? "+" : "";
    console.log(`\n${rb.name} vs ${ra.name}: ${sign}${fmt(c.delta)} DPS ± ${fmt(c.error95)} (${sign}${fmt(c.pct, 2)}%), same ${ra.iterations} fights`);
  } else if (command === "weights" && paths.length === 1) {
    const config = await loadConfig(paths[0]!, flag);
    // Steps big enough to stand out of the noise, small enough to stay roughly linear.
    const weights = statWeights(game, config, {
      agility: 20,
      rangedAttackPower: 40,
      critPct: 1,
      hitPct: 1,
      intellect: 20,
      spirit: 20,
      mp5: 5,
    });
    console.log(`\nStat weights for ${config.name ?? paths[0]}, 1 ranged attack power = 1.00\n`);
    console.log(
      table([
        ["Stat", "DPS per point", "± 95%", "Relative"],
        ...weights.map((w) => [w.stat, fmt(w.dpsPerPoint, 3), fmt(w.error95, 3), fmt(w.relative, 2)]),
      ]),
    );
  } else if (command === "optimize" && paths.length === 1) {
    const config = await loadConfig(paths[0]!, () => undefined);
    const result = optimize(game, config, {
      pool: flag("pool")?.split(",") ?? DEFAULT_POOL,
      iterations: Number(flag("iterations") ?? 300),
      budget: Number(flag("budget") ?? 200),
      mutantsPerRound: 8,
      confirmIterations: 5000,
      seed: flag("seed") ?? "optimize",
      onProgress: (msg) => console.log(msg),
    });
    const c = result.confirm;
    console.log(`\n${result.evaluated} rotations tried. On 5000 fresh fights:`);
    console.log(`  start ${fmt(c.before.dps.mean)} DPS, best ${fmt(c.after.dps.mean)} DPS, ${c.delta >= 0 ? "+" : ""}${fmt(c.delta)} ± ${fmt(c.error95)} (${fmt(c.pct, 2)}%)`);
    console.log(`  out of mana ${fmt(c.before.oomPct)}% -> ${fmt(c.after.oomPct)}% of the time`);
    const toml = actionsToml(result.bestActions);
    console.log(`\nBest rotation:\n\n${toml}`);
    print(c.after);
    const out = flag("out");
    if (out) {
      const source = await Bun.file(paths[0]!).text();
      const head = source.slice(0, source.indexOf("[[rotation.actions]]")).trimEnd();
      await Bun.write(out, `${head}\n\n${toml}\n`);
      console.log(`\nwrote ${out}`);
    }
  } else {
    console.error(USAGE);
    process.exit(2);
  }

  const guesses = unconfirmed(game.overrides).filter((u) => u.confidence === "guess");
  console.log(`\n${guesses.length} values in overrides.toml are guesses, e.g. ${guesses.slice(0, 4).map((g) => g.key).join(", ")}`);
  console.log(`${fmt((performance.now() - started) / 1000, 2)} sec`);
}

await main(process.argv.slice(2));
