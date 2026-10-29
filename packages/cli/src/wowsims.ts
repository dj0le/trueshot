// Runs a wowsims/forever export through wowsims' own command line sim, for checking this sim against it.
//
//   bun run wowsims build                          clone or update wowsims/forever and build wowsimcli
//   bun run wowsims run <export.json> [--iterations N] [--seed N] [--raw out.json]
//   bun run wowsims export <config.toml> <template.json> <out.json>
//   bun run wowsims search <config.toml> <template.json> <out.json> [--budget N] [--iterations N] [--climbs N] [--config-only] [--spec bm|mm|sv]
//
// export writes one of our configs as a wowsims export, to import in the wowsims UI or run above. The
// template (a wowsims export) supplies what our configs do not carry in wowsims terms: raid buffs,
// debuffs, consumables, encounter, gear, race and pet options. Ours replaces the talents and pet
// family, and picks the APL by position: shooting keeps the template's APL, weaving and melee get
// wowsims' own. The APL's switches (Use Aimed Shot, Use Sniper Shot, ...) follow which shots our
// rotation lists.
//
// search runs our build search (talents, pet, play style) with wowsims scoring every candidate, then
// tries each APL switch, and writes the best as a wowsims export.
//
//   bun run wowsims tune <export.json> <out.json> [--iterations N]
//
// tune keeps an export's talents and tries every value of each wowsims option in turn (race, pet
// family, pet attack speed, Cobra Reflexes, Pet Aggression, the APL switches, the weave's Auto Shot
// delay, the Sniper Shot rule),
// keeping a change when it wins on the same fights by more than the noise, until none does.
//
// The export is what the wowsims UI copies as JSON (IndividualSimSettings). The checkout lives next to
// this repo (../wowsims-forever) unless WOWSIMS_DIR says otherwise; wowsimcli and protoc-gen-go are
// built into its .tools folder. Building needs Go and protoc.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadGameData } from "@trueshot/data";
import { configBuild, describeBuild, searchBuilds, SimConfig, type SimConfigInput, type SimResult, specTree, withBuild } from "@trueshot/engine";
import { loadConfig } from "./toml";

const REPO = "https://github.com/wowsims/forever.git";
const DIR = resolve(process.env.WOWSIMS_DIR ?? join(import.meta.dir, "..", "..", "..", "..", "wowsims-forever"));
const TOOLS = join(DIR, ".tools");
const CLI = join(TOOLS, "wowsimcli");

async function sh(cmd: string[], cwd = DIR, env: Record<string, string> = {}): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}):\n${err || out}`);
  return out;
}

async function build(): Promise<void> {
  if (!existsSync(DIR)) await sh(["git", "clone", "--depth", "1", REPO, DIR], join(DIR, ".."));
  else await sh(["git", "pull", "--ff-only"]);
  // protoc-gen-go at the protobuf version wowsims pins.
  const mod = await Bun.file(join(DIR, "go.mod")).text();
  const version = /google\.golang\.org\/protobuf (v[\d.]+)/.exec(mod)?.[1];
  if (!version) throw new Error("go.mod: no google.golang.org/protobuf version");
  await sh(["go", "install", `google.golang.org/protobuf/cmd/protoc-gen-go@${version}`], DIR, { GOBIN: TOOLS });
  const path = `${TOOLS}:${process.env.PATH}`;
  await sh(["make", "sim/core/proto/api.pb.go"], DIR, { PATH: path });
  await sh(["go", "build", "--tags=with_db", "-o", CLI, "./cmd/wowsimcli"], DIR, { PATH: path });
  console.log(`built ${CLI} at ${(await sh(["git", "log", "-1", "--format=%h %cd"])).trim()}`);
}

type Json = Record<string, any>;

// The UI's individual sim, as the raid request wowsimcli takes: the player alone in a party.
// saveAllValues keeps each fight's DPS, in seed order, for paired comparisons.
function raidRequest(settings: Json, iterations: number, seed: number): Json {
  return {
    raid: {
      parties: [{ players: [settings.player], buffs: settings.partyBuffs ?? {} }],
      buffs: settings.raidBuffs ?? {},
      debuffs: settings.debuffs ?? {},
      tanks: settings.tanks ?? [],
    },
    encounter: settings.encounter,
    simOptions: { iterations, randomSeed: seed, saveAllValues: true },
    type: "SimTypeIndividual",
  };
}

// Runs wowsimcli on an export and returns its RaidSimResult. Synchronous, so it can score candidates
// inside a search.
function simulateWowsims(settings: Json, iterations: number, seed: number, out = join(TOOLS, "result.json")): Json {
  if (!existsSync(CLI)) throw new Error(`${CLI} not built; run \`bun run wowsims build\` first`);
  const tmp = join(TOOLS, "request.json");
  writeFileSync(tmp, JSON.stringify(raidRequest(settings, iterations, seed)));
  const p = Bun.spawnSync([CLI, "sim", "--infile", tmp, "--outfile", out], { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`wowsimcli failed: ${p.stderr.toString()}`);
  const result = JSON.parse(readFileSync(out, "utf8")) as Json;
  if (result.error) throw new Error(`wowsims: ${JSON.stringify(result.error)}`);
  return result;
}

async function run(path: string, iterations: number, seed: number, raw?: string): Promise<void> {
  const result = simulateWowsims(await Bun.file(path).json(), iterations, seed, raw ? resolve(raw) : undefined);
  const player = result.raidMetrics.parties[0].players[0] as Json;

  const game = await loadGameData();
  const OTHER: Record<string, string> = { OtherActionShoot: "Auto Shot", OtherActionAttack: "Melee" };
  const name = (id: Json) => {
    if (id.spellId) return game.data.spells[String(id.spellId)]?.name ?? `spell ${id.spellId}`;
    if (id.itemId) return game.items.get(id.itemId)?.name ?? `item ${id.itemId}`;
    return OTHER[id.otherId] ?? String(id.otherId ?? "?");
  };
  // Only what lands on the enemy counts (Demonic Rune hits the hunter).
  const enemies = new Set((result.encounterMetrics?.targets ?? []).map((t: Json) => t.unitIndex ?? 0));
  const rows = (unit: Json, prefix: string) =>
    (unit.actions ?? []).map((a: Json) => {
      const t = (a.targets ?? []).filter((x: Json) => enemies.has(x.unitIndex ?? 0)).reduce(
        (s: Json, x: Json) => ({
          damage: s.damage + (x.damage ?? 0),
          casts: s.casts + (x.casts ?? 0),
          hits: s.hits + (x.hits ?? 0) + (x.crits ?? 0) + (x.glances ?? 0),
          crits: s.crits + (x.crits ?? 0),
          misses: s.misses + (x.misses ?? 0) + (x.dodges ?? 0) + (x.parries ?? 0),
          ticks: s.ticks + (x.ticks ?? 0) + (x.critTicks ?? 0),
        }),
        { damage: 0, casts: 0, hits: 0, crits: 0, misses: 0, ticks: 0 },
      );
      return { name: prefix + name(a.id), ...t };
    });
  // The player's DPS already includes the pet's; each action gets its share of it.
  const merged = new Map<string, Json>();
  for (const a of [...rows(player, ""), ...(player.pets ?? []).flatMap((p: Json) => rows(p, `${p.name}: `))]) {
    const m = merged.get(a.name);
    merged.set(a.name, m ? Object.fromEntries(Object.keys(a).map((k) => [k, k === "name" ? a.name : m[k] + a[k]])) : a);
  }
  const actions = [...merged.values()].filter((a) => a.damage > 0);
  const damage = actions.reduce((s, a) => s + a.damage, 0);
  const all: Json[] = actions.map((a) => ({ ...a, dps: (player.dps.avg * a.damage) / damage })).sort((a, b) => b.dps - a.dps);
  const n = iterations;
  const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "0.0");
  console.log(`\nwowsims: ${player.dps.avg.toFixed(1)} DPS ± ${player.dps.stdev.toFixed(1)} sd, pet included; ${n} fights\n`);
  const table = [
    ["Ability", "DPS", "Casts", "Hits", "Ticks", "Crit%", "Miss%", "Avg hit"],
    ...all.map((a) => [
      a.name,
      a.dps.toFixed(1),
      (a.casts / n).toFixed(1),
      (a.hits / n).toFixed(1),
      (a.ticks / n).toFixed(1),
      pct(a.crits, a.hits),
      pct(a.misses, a.hits + a.misses),
      (a.damage / Math.max(1, a.hits + a.ticks)).toFixed(0),
    ]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((r) => r[i]!.length)));
  for (const r of table) console.log(r.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  "));
}

const RACES = ["RaceHuman", "RaceDwarf", "RaceNightElf", "RaceOrc", "RaceTauren", "RaceTroll", "RaceHighOrderSkyborne", "RaceWindshaperSkyborne"];
const PET_TYPES = ["Bat", "Bear", "BirdOfPrey", "Boar", "CarrionBird", "Cat", "CoreHound", "Crab", "Crocilisk", "Fox", "Gorilla", "Hyena", "Raptor", "Scorpid", "Spider", "Tallstrider", "Turtle", "WindSerpent", "Wolf"];
const PET_SPEEDS = ["PetAttackSpeedNone", "SlowerAttackIII", "SlowerAttackII", "FasterAttackI", "FasterAttackII", "FasterAttackIII", "FasterAttackIV", "FasterAttackV", "FasterAttackVI", "FasterAttackVII"];
// Sniper Shot as wowsims' APL names it (their export casts this id).
const SNIPER_SHOT = 1310786;
// Our pet family names where wowsims spells them differently.
const PETS: Record<string, string> = { Crocolisk: "Crocilisk" };
// The APL switches and the rotation action each one stands for.
const SWITCHES: Record<string, string> = {
  aimed_shot: "Use Aimed Shot",
  arcane_shot: "Use Arcane Shot",
  multi_shot: "Use Multi-Shot",
  sniper_shot: "Use Sniper Shot",
  summon_hawk: "Use Summon Hawk",
};

type Wowsims = { trees: Json[]; apls: { weave: Json; melee: Json } };

async function loadWowsims(): Promise<Wowsims> {
  const apl = (name: string) => Bun.file(join(DIR, "ui", "specs", "hunter", "dps", "apls", `${name}.apl.json`)).json();
  return {
    trees: await Bun.file(join(DIR, "ui", "sim", "talents", "trees", "hunter.json")).json(),
    apls: { weave: await apl("default"), melee: await apl("melee") },
  };
}

// wowsims' talent string: each tree's ranks in their tree order, trailing zeros dropped, trees joined by "-".
function talentString(ws: Wowsims, talents: Record<string, number>): string {
  const known = new Set(ws.trees.flatMap((t) => t.talents.map((x: Json) => x.fancyName)));
  for (const [name, rank] of Object.entries(talents)) if (rank > 0 && !known.has(name)) throw new Error(`wowsims has no talent "${name}"`);
  return ws.trees
    .map((t) => t.talents.map((x: Json) => String(talents[x.fancyName] ?? 0)).join("").replace(/0+$/, ""))
    .join("-")
    .replace(/-+$/, "");
}

// One of our configs as a wowsims export, on the template's gear, buffs and encounter.
function toWowsims(ws: Wowsims, input: SimConfigInput, template: Json): Json {
  const config = SimConfig.parse(input);
  const build = configBuild(config);
  const out = structuredClone(template);
  const player = out.player;
  player.talentsString = talentString(ws, build.talents);
  player.hunter.options.classOptions.petType = build.pet ? (PETS[build.pet] ?? build.pet.replace(/ /g, "")) : "PetNone";
  const apl = config.position === "ranged" ? player.rotation : structuredClone(ws.apls[config.position]);
  const uses = new Set(config.rotation.actions.map((a) => a.action));
  for (const [action, name] of Object.entries(SWITCHES)) {
    const v = (apl.valueVariables ?? []).find((x: Json) => x.name === name);
    if (v) v.value = { const: { val: String(uses.has(action)) } };
  }
  if (config.position === "weave") {
    apl.valueVariables.find((x: Json) => x.name === "Max Auto Shot delay").value = { const: { val: `${config.weave.maxAutoShotDelayMs / 1000}s` } };
    // Their weave APL has no Sniper Shot: it goes in after Serpent Sting.
    if (uses.has("sniper_shot")) {
      const i = apl.priorityList.findIndex((a: Json) => a.action?.castSpell?.spellId?.spellId === 25295);
      apl.priorityList.splice(i + 1, 0, { action: { castSpell: { spellId: { spellId: SNIPER_SHOT } } } });
    }
    player.distanceFromTarget = config.weave.shootRangeYd;
  }
  player.rotation = apl;
  return out;
}

async function exportConfig(configPath: string, templatePath: string, outPath: string): Promise<void> {
  const out = toWowsims(await loadWowsims(), await loadConfig(configPath), await Bun.file(templatePath).json());
  await Bun.write(outPath, JSON.stringify(out, null, 2));
  const p = out.player;
  console.log(`wrote ${outPath}: ${p.race}, ${p.talentsString}, pet ${p.hunter.options.classOptions.petType}`);
}

// A seed string as the number wowsims takes.
const seedNumber = (seed: string) => [...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// A wowsims run in the shape our searches compare: mean DPS and each fight's DPS in seed order.
function wowsimsResult(ws: Wowsims, template: Json, input: SimConfigInput): SimResult {
  const fight = SimConfig.parse(input).fight;
  const result = simulateWowsims(toWowsims(ws, input, template), fight.iterations, seedNumber(fight.seed));
  const dps = result.raidMetrics.parties[0].players[0].dps;
  const samples = dps.allValues as number[];
  if (samples.length !== fight.iterations) throw new Error(`wowsims returned ${samples.length} fights, not ${fight.iterations}`);
  const error95 = (1.96 * dps.stdev) / Math.sqrt(samples.length);
  return {
    name: SimConfig.parse(input).name,
    iterations: samples.length,
    dps: { mean: dps.avg, stdDev: dps.stdev, min: dps.min, max: dps.max, error95 },
    samples,
    abilities: [],
    manaSpentPerFight: 0,
    manaLeftPct: 0,
    oomPct: 0,
    unimplemented: [],
  };
}

async function search(configPath: string, templatePath: string, outPath: string, budget: number, iterations: number, climbs: number, configOnly: boolean, spec: string | undefined): Promise<void> {
  const ws = await loadWowsims();
  const template = await Bun.file(templatePath).json();
  const game = await loadGameData();
  const config = await loadConfig(configPath);
  const evaluate = (c: SimConfigInput) => wowsimsResult(ws, template, c);
  const log = (msg: string) => console.log(msg);
  const found = searchBuilds(game, config, {
    iterations,
    budget,
    mutantsPerRound: 8,
    climbs,
    configOnly,
    pets: true,
    styles: true,
    spec,
    seed: "wowsims",
    onProgress: log,
    evaluate,
  });
  // The APL switches: one at a time, kept while one helps by more than the noise.
  let best = withBuild(config, found.best);
  const fight = { ...config.fight, iterations, seed: "wowsims/switches" };
  let bestResult = evaluate({ ...best, fight });
  for (let improved = true; improved; ) {
    improved = false;
    for (const action of Object.keys(SWITCHES)) {
      const actions = best.rotation.actions.some((a) => a.action === action)
        ? best.rotation.actions.filter((a) => a.action !== action)
        : [...best.rotation.actions, { action }];
      const candidate = { ...best, rotation: { ...best.rotation, actions } };
      const r = evaluate({ ...candidate, fight });
      const delta = r.dps.mean - bestResult.dps.mean;
      const paired = r.samples.map((x, i) => x - bestResult.samples[i]!);
      const sd = Math.sqrt(paired.reduce((s, x) => s + (x - delta) ** 2, 0) / (paired.length - 1));
      if (delta > (1.96 * sd) / Math.sqrt(paired.length)) {
        log(`${SWITCHES[action]} ${actions.length > best.rotation.actions.length ? "on" : "off"}: +${delta.toFixed(1)} DPS`);
        best = candidate;
        bestResult = r;
        improved = true;
      }
    }
  }
  const confirm = { ...config.fight, iterations: 10000, seed: "wowsims/confirm" };
  const before = evaluate({ ...config, fight: confirm });
  const after = evaluate({ ...best, fight: confirm });
  const out = toWowsims(ws, best, template);
  await Bun.write(outPath, JSON.stringify(out, null, 2));
  const switches = Object.entries(SWITCHES).filter(([a]) => best.rotation.actions.some((x) => x.action === a)).map(([, n]) => n);
  console.log(`\nBest in wowsims: ${describeBuild(game.data, configBuild(best))}`);
  console.log(`talents ${out.player.talentsString}, ${switches.join(", ") || "no switches on"}`);
  console.log(`On 10000 fresh fights: start ${before.dps.mean.toFixed(1)} DPS, best ${after.dps.mean.toFixed(1)} DPS (${(after.dps.mean - before.dps.mean).toFixed(1)}, ${((100 * (after.dps.mean - before.dps.mean)) / before.dps.mean).toFixed(2)}%)`);
  console.log(`wrote ${outPath} (${found.evaluated} builds scored)`);
}

// Every value of one option, as a change to an export; null when the export has no such option.
type Option = { name: string; values: string[]; get: (e: Json) => string | null; set: (e: Json, v: string) => void };

const variable = (e: Json, name: string) => (e.player.rotation.valueVariables ?? []).find((x: Json) => x.name === name);
// The Sniper Shot action in the export's APL, and its "only in Rapid Fire or Quick Shots" condition.
const sniperAction = (e: Json) => e.player.rotation.priorityList.find((a: Json) => a.action?.castSpell?.spellId?.spellId === SNIPER_SHOT)?.action;

const OPTIONS: Option[] = [
  { name: "race", values: RACES, get: (e) => e.player.race, set: (e, v) => (e.player.race = v) },
  { name: "pet", values: ["PetNone", ...PET_TYPES], get: (e) => e.player.hunter.options.classOptions.petType, set: (e, v) => (e.player.hunter.options.classOptions.petType = v) },
  {
    name: "pet attack speed",
    values: PET_SPEEDS,
    get: (e) => e.player.hunter.options.classOptions.petAttackSpeed ?? "PetAttackSpeedNone",
    set: (e, v) => (e.player.hunter.options.classOptions.petAttackSpeed = v),
  },
  {
    name: "Cobra Reflexes",
    values: ["true", "false"],
    get: (e) => String(!!e.player.hunter.options.classOptions.cobraReflexes),
    set: (e, v) => (e.player.hunter.options.classOptions.cobraReflexes = v === "true"),
  },
  {
    name: "Pet Aggression",
    values: ["0", "1", "2", "3", "4", "5"],
    get: (e) => String(e.player.hunter.options.classOptions.petAggression ?? 0),
    set: (e, v) => (e.player.hunter.options.classOptions.petAggression = Number(v)),
  },
  ...Object.values(SWITCHES).map(
    (name): Option => ({
      name,
      values: ["true", "false"],
      get: (e) => variable(e, name)?.value?.const?.val ?? null,
      set: (e, v) => (variable(e, name).value = { const: { val: v } }),
    }),
  ),
  {
    // How far a weave may push the next Auto Shot back (wowsims' weave APL).
    name: "Max Auto Shot delay",
    values: ["0.3s", "0.45s", "0.6s", "0.75s", "0.9s", "1.2s", "1.5s", "2s"],
    get: (e) => variable(e, "Max Auto Shot delay")?.value?.const?.val ?? null,
    set: (e, v) => (variable(e, "Max Auto Shot delay").value = { const: { val: v } }),
  },
  {
    // His APL casts Sniper Shot only while Rapid Fire or Quick Shots is up; "always" drops that part.
    name: "Sniper Shot rule",
    values: ["his", "always"],
    get: (e) => (sniperAction(e) ? (sniperAction(e).condition?.and ? "his" : "always") : null),
    set: (e, v) => {
      const a = sniperAction(e);
      if (v === "always") a.condition = { variableRef: { name: "Use Sniper Shot" } };
    },
  },
];

async function tune(path: string, outPath: string, iterations: number): Promise<void> {
  let best = await Bun.file(path).json();
  const score = (e: Json) => simulateWowsims(e, iterations, 1).raidMetrics.parties[0].players[0].dps as Json;
  let bestDps = score(best);
  const start = bestDps.avg;
  console.log(`start ${start.toFixed(1)} DPS`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const o of OPTIONS) {
      const current = o.get(best);
      if (current === null) continue;
      const tried: string[] = [];
      for (const v of o.values.filter((x) => x !== current)) {
        const candidate = structuredClone(best);
        o.set(candidate, v);
        let dps: Json;
        try {
          dps = score(candidate);
        } catch {
          continue;
        }
        const paired = (dps.allValues as number[]).map((x, i) => x - bestDps.allValues[i]);
        const delta = dps.avg - bestDps.avg;
        const sd = Math.sqrt(paired.reduce((s, x) => s + (x - delta) ** 2, 0) / (paired.length - 1));
        tried.push(`${v} ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`);
        if (delta > (1.96 * sd) / Math.sqrt(paired.length)) {
          best = candidate;
          bestDps = dps;
          changed = true;
        }
      }
      console.log(`${o.name}: ${o.get(best)} (tried ${tried.join(", ")})`);
    }
  }
  await Bun.write(outPath, JSON.stringify(best, null, 2));
  console.log(`\n${start.toFixed(1)} -> ${bestDps.avg.toFixed(1)} DPS (${((100 * (bestDps.avg - start)) / start).toFixed(2)}%), wrote ${outPath}`);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { iterations: { type: "string" }, seed: { type: "string" }, raw: { type: "string" }, budget: { type: "string" }, climbs: { type: "string" }, "config-only": { type: "boolean" }, spec: { type: "string" } },
});
const [command, file, template, outFile] = positionals;
if (command === "build") await build();
else if (command === "export" && file && template && outFile) await exportConfig(file, template, outFile);
else if (command === "tune" && file && template) await tune(file, template, Number(values.iterations ?? 3000));
else if (command === "search" && file && template && outFile)
  await search(file, template, outFile, Number(values.budget ?? 400), Number(values.iterations ?? 1000), Number(values.climbs ?? 3), !!values["config-only"], specTree(values.spec));

else if (command === "run" && file) await run(file, Number(values.iterations ?? 3000), Number(values.seed ?? 1), values.raw);
else {
  console.error("usage: see the top of packages/cli/src/wowsims.ts");
  process.exit(2);
}
