// hunter-sim command line; USAGE below lists the commands.
//
// A config may start with `extends = "other.toml"` (relative to itself) and set only what differs.
// Tables merge key by key; anything else, rotation.actions included, replaces the parent's value.
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadGameData, unconfirmed } from "@hunter-sim/data";
import {
  actionValues,
  compareResults,
  optimize,
  simulate,
  statWeights,
  type ActionConfig,
  type SimConfigInput,
  type SimResult,
} from "@hunter-sim/engine";

const fmt = (n: number, digits = 1) => n.toFixed(digits);
const signed = (n: number, digits = 1) => `${n >= 0 ? "+" : ""}${fmt(n, digits)}`;

// The first `textColumns` columns align left, the numbers after them right.
function table(rows: string[][], textColumns = 1): string {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) => r.map((c, i) => (i < textColumns ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ").trimEnd())
    .join("\n");
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

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(parent: Table, child: Table): Table {
  const out = { ...parent };
  for (const [k, v] of Object.entries(child)) out[k] = isTable(v) && isTable(out[k]) ? merge(out[k] as Table, v) : v;
  return out;
}

async function readToml(path: string, seen: string[] = []): Promise<Table> {
  if (seen.includes(path)) throw new Error(`config: extends loops back to ${path}`);
  const { extends: parent, ...own } = Bun.TOML.parse(await Bun.file(path).text()) as Table;
  if (typeof parent !== "string") return own;
  return merge(await readToml(resolve(dirname(path), parent), [...seen, path]), own);
}

async function loadConfig(path: string, fight: { iterations?: string | undefined; seed?: string | undefined } = {}): Promise<SimConfigInput> {
  const config = (await readToml(resolve(path))) as SimConfigInput;
  config.fight = { ...config.fight };
  if (fight.iterations) config.fight.iterations = Number(fight.iterations);
  if (fight.seed) config.fight.seed = fight.seed;
  return config;
}

const USAGE = [
  "usage:",
  "  bun run sim run <config.toml> [--iterations N] [--seed S]",
  "  bun run sim compare <base.toml> <variant.toml>... [--iterations N] [--seed S]",
  "  bun run sim value <config.toml> [--iterations N]      what each rotation action is worth",
  "  bun run sim weights <config.toml> [--iterations N]",
  "  bun run sim optimize <config.toml> [--budget N] [--iterations N] [--pool a,b] [--out file.toml]",
].join("\n");

// Damage and cooldown actions the optimizer may add even when the starting rotation leaves them
// out. Ones the character does not know are skipped, so one list serves every spec.
const DEFAULT_POOL = [
  "hunters_mark",
  "rapid_fire",
  "bestial_wrath",
  "intimidation",
  "serpent_sting",
  "aimed_shot",
  "sniper_shot",
  "multi_shot",
  "arcane_shot",
  "volley",
];

// Where a variant's damage moved, ability by ability.
function printDiff(base: SimResult, other: SimResult): void {
  const names = [...new Set([...base.abilities, ...other.abilities].map((a) => a.name))];
  const rows = names
    .map((name) => {
      const a = base.abilities.find((x) => x.name === name);
      const b = other.abilities.find((x) => x.name === name);
      return { name, dps: (b?.dps ?? 0) - (a?.dps ?? 0), casts: (b?.castsPerFight ?? 0) - (a?.castsPerFight ?? 0) };
    })
    .filter((r) => Math.abs(r.dps) >= 0.05 || Math.abs(r.casts) >= 0.05)
    .sort((x, y) => Math.abs(y.dps) - Math.abs(x.dps));
  console.log(
    table([
      ["Ability", "DPS", "Casts"],
      ...rows.map((r) => [r.name, signed(r.dps), signed(r.casts)]),
      ["Out of mana %", signed(other.oomPct - base.oomPct), ""],
    ]),
  );
}

function actionsToml(actions: ActionConfig[]): string {
  return actions
    .map((a) => `[[rotation.actions]]\naction = "${a.action}"${a.if ? `\nif = "${a.if}"` : ""}`)
    .join("\n\n");
}

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      iterations: { type: "string" },
      seed: { type: "string" },
      budget: { type: "string" },
      pool: { type: "string" },
      out: { type: "string" },
    },
  });
  const [command, ...paths] = positionals;
  const game = await loadGameData();
  const started = performance.now();

  if (command === "run" && paths.length === 1) {
    print(simulate(game, await loadConfig(paths[0]!, flags)));
  } else if (command === "compare" && paths.length >= 2) {
    const [base, ...variants] = await Promise.all(paths.map((p) => loadConfig(p, flags)));
    const rb = simulate(game, base!);
    print(rb);
    for (const v of variants) {
      // Paired fights need identical lengths and seeds, so every variant borrows the base's.
      const rv = simulate(game, { ...v, fight: { ...base!.fight } });
      const c = compareResults(rb, rv);
      console.log(`\n${rv.name} vs ${rb.name}: ${signed(c.delta)} DPS ± ${fmt(c.error95)} (${signed(c.pct, 2)}%), same ${rb.iterations} fights\n`);
      printDiff(rb, rv);
    }
  } else if (command === "value" && paths.length === 1) {
    const config = await loadConfig(paths[0]!, flags);
    const values = actionValues(game, config);
    console.log(`\nWhat each action in ${config.name ?? paths[0]} is worth: DPS lost without it (paired fights)\n`);
    console.log(
      table([
        ["Action", "Condition", "DPS", "± 95%", "%"],
        ...values.map((v) => [v.action, v.condition ?? "", signed(v.delta), fmt(v.error95), signed(v.pct, 2)]),
      ], 2),
    );
  } else if (command === "weights" && paths.length === 1) {
    const config = await loadConfig(paths[0]!, flags);
    // Steps big enough to stand out of the noise, small enough to stay roughly linear.
    const weights = statWeights(game, config, {
      agility: 20,
      rangedAttackPower: 40,
      critPct: 1,
      hitPct: 1,
      hastePct: 1,
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
    const config = await loadConfig(paths[0]!);
    const result = optimize(game, config, {
      pool: flags.pool?.split(",") ?? DEFAULT_POOL,
      iterations: Number(flags.iterations ?? 300),
      budget: Number(flags.budget ?? 200),
      mutantsPerRound: 8,
      confirmIterations: 5000,
      seed: flags.seed ?? "optimize",
      onProgress: (msg) => console.log(msg),
    });
    const c = result.confirm;
    console.log(`\n${result.evaluated} rotations tried. On ${c.after.iterations} fresh fights:`);
    console.log(`  start ${fmt(c.before.dps.mean)} DPS, best ${fmt(c.after.dps.mean)} DPS, ${signed(c.delta)} ± ${fmt(c.error95)} (${fmt(c.pct, 2)}%)`);
    console.log(`  out of mana ${fmt(c.before.oomPct)}% -> ${fmt(c.after.oomPct)}% of the time`);
    const toml = actionsToml(result.bestActions);
    console.log(`\nBest rotation:\n\n${toml}`);
    print(c.after);
    const out = flags.out;
    if (out && c.delta <= c.error95) {
      console.log(`\nnot writing ${out}: the best rotation is not clearly better than the original on fresh fights`);
    } else if (out) {
      const source = await Bun.file(paths[0]!).text();
      // The new actions replace the old ones, which are expected to end the file.
      const actionsAt = source.indexOf("[[rotation.actions]]");
      const head = (actionsAt < 0 ? source : source.slice(0, actionsAt)).trimEnd();
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
