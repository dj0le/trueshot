// Trueshot command line; USAGE below lists the commands.
import { parseArgs } from "node:util";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type ActorLog,
  actors,
  DEFAULT_DB,
  DEFAULT_LOGS_DIR,
  defaultSheetFiles,
  type GameData,
  hitsBy,
  hunters,
  ingest,
  ingestSheets,
  loadGameData,
  openStore,
  parseLog,
  pressesIn,
  unconfirmed,
} from "@trueshot/data";
import {
  actionValues,
  compareResults,
  configBuild,
  defaultPetAbilities,
  SimConfig,

  describeBuild,
  optimize,
  optimizeBuild,
  petSweep,
  specTree,

  simulate,
  snake,
  specOf,
  statWeights,
  type SimConfigInput,
  type SimResult,
} from "@trueshot/engine";
import { claims } from "./claims";
import { type FightReview, listFights, review } from "./review";
import { actionsToml, buildToml, loadConfig } from "./toml";

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
  console.log(
    `Mana spent per fight ${fmt(r.manaSpentPerFight, 0)}, ${fmt(r.manaLeftPct, 0)}% left unused at the end, out of mana ${fmt(r.oomPct)}% of the time\n`,
  );
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

const USAGE = [
  "usage:",
  "  every command that runs fights takes --fight <preset>, a fight length from overrides.toml [fights]",
  "  (dungeon-trash-30, dungeon-boss-30, dungeon-trash-60, dungeon-boss-60, raid-boss)",
  "  bun run sim run <config.toml> [--iterations N] [--seed S]",
  "  bun run sim compare <base.toml> <variant.toml>... [--iterations N] [--seed S]",
  "  bun run sim value <config.toml> [--iterations N]      what each rotation action is worth",
  "  bun run sim weights <config.toml> [--iterations N]",
  "  bun run sim optimize <config.toml> [--budget N] [--iterations N] [--pool a,b] [--out file.toml]",
  "  bun run sim pets <config.toml> [--iterations N]       every pet family, and none, with these talents",
  "  bun run sim calibrate <calibration.toml> <config.toml>  damage shares against recorded fights",
  "  bun run sim log <WoWCombatLog.txt> [--actor name]     hunters and pets in a combat log; --actor lists every hit",
  "  bun run sim ingest [WoWCombatLog.txt...] [--watch] [--db file] [--sheets Trueshot.lua]",
  "                                                        new lines of the logs (default: the launch client's Logs folder) and the",
  "                                                        recorder addon's character sheets into the local store; --watch: every 30 sec",
  "  bun run sim claims [--hunter name] [--db file]        claimed vs reality: client data, tooltips and our model against the store",
  "  bun run sim review [fight] [--hunter name] [--config file.toml] [--db file]",
  "                                                        the stored fights, or one fight's casts, Auto Shot timing, uptimes, mana",
  "                                                        and movement; --config also sims it at the logged length and target level",
  "  bun run sim presses [--hunter name] [--db file]       button presses the addon recorded, most used first, for keybinds",
  "  bun run sim beta <config.toml>...                     each config against the beta dungeon bosses, next to Forever Logs parses",
  "  bun run sim enchants <text>                           enchant ids for gear.enchants, by name",
  "  bun run sim build <config.toml> [--budget N] [--rotation-budget N] [--rounds N] [--iterations N] [--keep-pet] [--keep-style] [--spec bm|mm|sv] [--out file.toml]",
  "                                                        talents, pet, play style and rotation searched together;",
  "                                                        --spec keeps the most points in that tree",
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
  // Melee position; out of range from the other position, so harmless there.
  "raptor_strike",
  "mongoose_bite",
  "strider_kick",
  "lacerate",
  "wing_clip",
  "immolation_trap",
  "explosive_trap",
];

// Abilities only some builds can use, which a build search adds to the rotation when missing: ones
// talents teach, and the melee core and fire traps for melee and weaving (out of range or never
// springing, so left alone, when shooting).
// Intimidation is left out: casting it costs DPS (PLAN.md findings).
const TAUGHT = {
  precombat: ["trueshot_aura"],
  actions: ["bestial_wrath", "sniper_shot", "summon_hawk", "mongoose_bite", "raptor_strike", "immolation_trap", "explosive_trap"],
};

// The default pool plus the on-use items the config wears (trinkets).
function poolFor(game: GameData, config: SimConfigInput): string[] {
  const worn = Object.values(config.gear.items ?? {}).flatMap((id) => game.items.get(id) ?? []);
  return [...DEFAULT_POOL, ...worn.filter((i) => i.useSpells.length).map((i) => snake(i.name))];
}

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
      ["Mana left %", signed(other.manaLeftPct - base.manaLeftPct), ""],
    ]),
  );
}

function printActor(a: ActorLog, label: string): void {
  console.log(`\n${label} ${a.name} (${a.guid}), ${a.guid.startsWith("Player-") ? "item level" : "level"} ${[...a.levels].sort((x, y) => x - y).join(", ") || "unknown"}`);
  console.log(
    table([
      ["Ability", "Damage", "Hits", "Crits", "Glances", "Misses", "Avg"],
      ...[...a.abilities.values()]
        .sort((x, y) => y.damage - x.damage)
        .map((s) => {
          const landed = s.hits + s.crits + s.glances;
          const misses = Object.entries(s.missTypes).map(([t, n]) => `${n} ${t.toLowerCase()}`).join(", ");
          return [s.name, String(s.damage), String(s.hits), String(s.crits), String(s.glances), misses || "0", landed ? fmt(s.damage / landed) : ""];
        }),
    ]),
  );
}

// The hunters in a combat log and their pets, or every hit of one unit (by name or guid).
function printLog(text: string, actor: string | undefined): void {
  const events = parseLog(text);
  const all = actors(events);
  if (!actor) {
    for (const { guid, hunter, pets } of hunters(all, events)) {
      if (hunter) printActor(hunter, "Hunter");
      else console.log(`\nHunter ${guid}: no damage of its own in the log`);
      for (const pet of pets) printActor(pet, "  Pet");
    }
    return;
  }
  const matches = [...all.values()].filter((a) => a.guid === actor || a.name.toLowerCase() === actor.toLowerCase());
  for (const a of matches) {
    printActor(a, a.owner ? `Pet of ${all.get(a.owner)?.name ?? a.owner}:` : "Unit");
    console.log(
      table([
        ["Time", "Ability", "Target", "Amount", "Before armor", "", "Level", "AP"],
        ...hitsBy(events, a.guid).map((h) => [
          fmt(h.timeMs / 1000),
          h.ability,
          h.target,
          String(h.amount),
          String(h.unmitigated),
          h.critical ? "crit" : h.glancing ? "glance" : "",
          h.level ? String(h.level) : "",
          h.attackPower ? String(h.attackPower) : "",
        ]),
      ], 3),
    );
  }
  if (matches.length === 0) console.log(`no unit named ${actor}`);
}

const CALIBRATION = new URL("../../data/calibration/", import.meta.url).pathname;

type DungeonParses = { name: string; hunter: Record<string, { parses: number; min: number; p25: number; median: number; p75: number; p90: number; max: number }> };

// Where a DPS lands among parses, as a percentile read off the known points.
function percentileOf(dps: number, p: DungeonParses["hunter"][string]): number {
  const points: [number, number][] = [[0, p.min], [25, p.p25], [50, p.median], [75, p.p75], [90, p.p90], [100, p.max]];
  if (dps <= p.min) return 0;
  for (let i = 1; i < points.length; i++) {
    const [pa, a] = points[i - 1]!;
    const [pb, b] = points[i]!;
    if (dps <= b) return b === a ? pb : pa + ((pb - pa) * (dps - a)) / (b - a);
  }
  return 100;
}

// A config against each beta dungeon near its level: the target at the dungeon's mean boss level,
// its spec's Forever Logs parses alongside. Parses carry no level or gear, so this is a range check.
async function beta(game: GameData, config: SimConfigInput, path: string): Promise<void> {
  const dungeons = (Bun.TOML.parse(await Bun.file(`${CALIBRATION}foreverlogs-beta.toml`).text()) as { dungeon: DungeonParses[] }).dungeon;
  const levels = Bun.TOML.parse(await Bun.file(`${CALIBRATION}beta-boss-levels.toml`).text()) as Record<string, Record<string, string>>;
  const level = SimConfig.parse(config).level;
  const spec = specOf(game.data, config.talents ?? {});
  console.log(`\n${config.name ?? path}: ${spec ?? "no spec"}, level ${level}`);
  const rows: string[][] = [["Dungeon", "Boss level", "Sim DPS", "Parses", "p25", "Median", "p75", "p90", "Sim percentile"]];
  for (const d of dungeons) {
    const parses = spec ? d.hunter[spec] : undefined;
    const bossLevels = Object.values(levels[d.name] ?? {}).map((l) => l.split("-").map(Number)).map((r) => (r[0]! + r.at(-1)!) / 2);
    if (!parses || bossLevels.length === 0) continue;
    const bossLevel = Math.round(bossLevels.reduce((a, b) => a + b, 0) / bossLevels.length);
    if (bossLevel < level - 6 || bossLevel > level + 5) continue;
    const { armor: _, ...target } = config.target ?? {};
    const r = simulate(game, { ...config, target: { ...target, level: bossLevel } });
    rows.push([
      d.name,
      String(bossLevel),
      fmt(r.dps.mean),
      String(parses.parses),
      fmt(parses.p25),
      fmt(parses.median),
      fmt(parses.p75),
      fmt(parses.p90),
      fmt(percentileOf(r.dps.mean, parses), 0),
    ]);
  }
  console.log(table(rows));
  console.log("Forever Logs (https://foreverlogs.gg), beta, boss damage only");
}

// A fight recorded from a damage meter: its length, the target where known, and damage by ability.
type RecordedFight = { name: string; durationSec: number; targetLevel?: number; targetArmor?: number; abilities: Record<string, number> };

// Each recorded fight simmed at its own length and target, its damage shares next to the meter's,
// then all fights pooled. Only abilities the meter lists count toward the shares on both sides.
async function calibrate(game: GameData, path: string, config: SimConfigInput): Promise<void> {
  const fights = (Bun.TOML.parse(await Bun.file(path).text()) as { fight: RecordedFight[] }).fight;
  const pooled = new Map<string, { real: number; sim: number }>();
  for (const f of fights) {
    const target = { ...config.target, ...(f.targetLevel ? { level: f.targetLevel } : {}), ...(f.targetArmor !== undefined ? { armor: f.targetArmor } : {}) };
    const { preset: _, ...fight } = config.fight ?? {};
    const r = simulate(game, { ...config, target, fight: { ...fight, durationSec: f.durationSec, durationVariancePct: 0 } });
    const realTotal = Object.values(f.abilities).reduce((a, b) => a + b, 0);
    const listed = r.abilities.filter((a) => a.name in f.abilities);
    const simTotal = listed.reduce((s, a) => s + a.dps, 0);
    const unlisted = r.abilities.filter((a) => !(a.name in f.abilities) && a.dps > 0).map((a) => a.name);
    console.log(`
${f.name}, ${f.durationSec} sec: meter ${fmt(realTotal / f.durationSec)} DPS, sim ${fmt(r.dps.mean)} DPS`);
    const rows = Object.entries(f.abilities).map(([name, dmg]) => {
      const sim = (r.abilities.find((a) => a.name === name)?.dps ?? 0) / simTotal;
      const p = pooled.get(name) ?? { real: 0, sim: 0 };
      pooled.set(name, { real: p.real + dmg / realTotal, sim: p.sim + sim });
      return [name, `${fmt((100 * dmg) / realTotal)}%`, `${fmt(100 * sim)}%`];
    });
    console.log(table([["Ability", "Meter", "Sim"], ...rows]));
    if (unlisted.length) console.log(`sim only, left out of the shares: ${unlisted.join(", ")}`);
  }
  console.log(`
Average share over ${fights.length} fights`);
  console.log(
    table([
      ["Ability", "Meter", "Sim", "Sim / meter"],
      ...[...pooled].map(([name, p]) => [name, `${fmt((100 * p.real) / fights.length)}%`, `${fmt((100 * p.sim) / fights.length)}%`, p.real ? fmt(p.sim / p.real, 2) : ""]),
    ]),
  );
}

// The given logs, or every WoWCombatLog file in the launch client's Logs folder, into the store.
async function ingestLogs(paths: string[], dbPath: string, watch: boolean, sheets: string | undefined): Promise<void> {
  const db = openStore(dbPath);
  const sheetFiles = sheets ? [sheets] : defaultSheetFiles();
  const files = () =>
    paths.length
      ? paths
      : readdirSync(DEFAULT_LOGS_DIR)
          .filter((f) => f.startsWith("WoWCombatLog"))
          .sort()
          .map((f) => join(DEFAULT_LOGS_DIR, f));
  for (;;) {
    for (const path of files()) {
      const r = await ingest(db, path);
      if (r.bytes) console.log(`${path}: ${r.lines} lines, ${r.kept} kept, ${r.hunters} hunters, ${r.fights} fights`);
    }
    // The recorder addon's sheets; WoW rewrites the file at logout and /reload.
    for (const path of sheetFiles) {
      const added = await ingestSheets(db, path);
      if (added.sheets || added.presses) console.log(`${path}: ${added.sheets} character sheets, ${added.presses} button presses`);
    }
    if (!watch) break;
    await Bun.sleep(30_000);
  }
  const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  console.log(`\n${dbPath}: ${count("SELECT COUNT(*) AS n FROM events")} events, ${count("SELECT COUNT(*) AS n FROM fights")} fights, ${count("SELECT COUNT(*) AS n FROM encounters")} encounters`);
}

const VERDICT_ORDER = { differs: 0, fits: 1, "too few": 2, observed: 3 } as const;

function printClaims(game: GameData, dbPath: string, hunter: string | undefined): void {
  const rows = claims(game, openStore(dbPath), hunter).sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]);
  console.log(`\nClaimed vs reality${hunter ? ` for ${hunter}` : ""}, from ${dbPath}\n`);
  console.log(
    table(
      [["Verdict", "Claim", "Subject", "Claimed", "Observed (95%)", "Source", "n"], ...rows.map((r) => [r.verdict, r.claim, r.subject, r.claimed, r.observed, r.source, String(r.n)])],
      6,
    ),
  );
}

function printFights(db: ReturnType<typeof openStore>, hunter: string | undefined): void {
  const fights = listFights(db, hunter);
  console.log(`\n${fights.length} fights${hunter ? ` for ${hunter}` : ""}; \`sim review <fight>\` for one\n`);
  console.log(
    table(
      [
        ["Fight", "Hunter", "Target", "Sec", "Damage", "DPS"],
        ...fights.map((f) => {
          const sec = Math.max(1, (f.endTs - f.startTs) / 1000);
          return [String(f.id), f.hunterName, f.label, fmt(sec), String(f.damage), fmt(f.damage / sec)];
        }),
      ],
      3,
    ),
  );
}

const pct = (x: number) => `${fmt(100 * x)}%`;

function printReview(r: FightReview): void {
  const total = r.damage.hunter + r.damage.pet;
  const f = r.fight;
  const t = r.target;
  console.log(`\nFight ${f.id}: ${f.hunterName} against ${f.label}, ${fmt(r.durationSec)} sec${r.level ? `, level ${r.level}` : ""}`);
  if (t) console.log(`Main target ${t.name}${t.level ? `, level ${t.level}` : ""}${t.armor ? `, ${t.armor} armor` : ""}`);
  console.log(`Damage ${total} (${fmt(total / r.durationSec)} DPS): you ${r.damage.hunter}, pet ${r.damage.pet}; overkill ${r.damage.overkill} (${pct(r.damage.overkill / Math.max(1, total))})\n`);

  console.log(
    table([
      ["Ability", "Casts", "Damage", "Share", "GCD and cast sec"],
      ...r.casts.map((c) => [c.dealsDamage ? c.name : `${c.name} (no damage)`, c.casts ? String(c.casts) : "", String(c.damage), pct(c.damage / Math.max(1, total)), fmt(c.busySec)]),
      ...r.petAbilities.map((p) => [p.name, p.casts ? String(p.casts) : "", String(p.damage), pct(p.damage / Math.max(1, total)), ""]),
    ]),
  );
  const utility = r.casts.filter((c) => !c.dealsDamage);
  if (utility.length) {
    const sec = utility.reduce((a, c) => a + c.busySec, 0);
    console.log(`\nNo-damage casts held the GCD or a cast bar for ${fmt(sec)} sec (${pct(sec / r.durationSec)} of the fight)`);
  }
  console.log(`Free time, no GCD or cast running: ${fmt(r.freeSec)} sec (${pct(r.freeSec / r.durationSec)})`);

  const a = r.autoShot;
  if (a.shots) {
    const speed = a.speedSec ? `${fmt(a.speedSec, 2)} sec bow${a.speedFromSheet ? "" : " (no sheet: the fastest gaps)"}` : "no bow speed";
    const lost = a.speedSec ? (a.delaySec + a.stoppedSec) / a.speedSec : 0;
    console.log(
      `\nAuto Shot: ${a.shots} shots, ${speed}; late by ${fmt(a.delaySec, 2)} sec in all, off for ${fmt(a.stoppedSec)} sec` +
        (a.speedSec ? `: about ${fmt(lost)} shots lost (${fmt(lost * a.avgDamage, 0)} damage at ${fmt(a.avgDamage, 0)} a shot)` : ""),
    );
  }
  for (const d of r.dots) {
    console.log(
      `${d.name}: ${d.applied} applied, ${d.ticks} ticks; ${fmt(d.lostToDeathSec)} of ${fmt(d.appliedSec)} sec lost to the target dying, ${fmt(d.clippedSec)} sec clipped by early refreshes`,
    );
  }

  const u = r.uptime;
  const up = [
    ...(u.mark !== undefined ? [`Hunter's Mark ${pct(u.mark)}`] : []),
    ...u.aspects.map((x) => `${x.name} ${pct(x.pct)}`),
    ...(u.pet !== undefined ? [`pet attacking ${pct(u.pet)}`] : ["no pet"]),
    ...(u.dazed ? [`Dazed ${u.dazed} times`] : []),
  ];
  console.log(`\nUptime: ${up.join(", ")}`);
  if (r.mana) console.log(`Mana: ${fmt(r.mana.startPct, 0)}% at the pull, lowest ${fmt(r.mana.minPct, 0)}%, ${fmt(r.mana.endPct, 0)}% at the end`);
  const m = r.movement;
  if (m.samples > 1) console.log(`Moving: about ${fmt(m.movingSec)} sec (${pct(m.movingSec / r.durationSec)}), ${fmt(m.yards, 0)} yd, from ${m.samples} positions`);

  if (r.failures.length) {
    console.log(`\nFailed casts`);
    console.log(table([["Spell", "Reason", "Times"], ...r.failures.map((x) => [x.name, x.reason, String(x.count)])], 2));
  }
  if (r.presses) {
    console.log(`\nButton presses`);
    console.log(table([["Action", "Presses", "Cast", "Did nothing"], ...r.presses.map((p) => [p.name, String(p.presses), String(p.casts), String(p.presses - p.casts)])]));
  }

  console.log(`\nTimeline (sec from the first hit)`);
  console.log(
    table(
      [
        ["Sec", "Cast", "Target", "Mana"],
        ...r.timeline.map((x) => [fmt(x.t), x.failed ? `${x.what} failed: ${x.failed}` : x.what, x.target, x.manaPct === undefined ? "" : `${fmt(x.manaPct, 0)}%`]),
      ],
      4,
    ),
  );
}

// The same fight simmed: the config at the logged length, against the main target's level and armor.
function printReviewSim(game: GameData, r: FightReview, config: SimConfigInput): void {
  const { preset: _, ...fight } = config.fight ?? {};
  const target = { ...config.target, ...(r.target?.level ? { level: r.target.level } : {}), ...(r.target?.armor ? { armor: r.target.armor } : {}) };
  const sim = simulate(game, { ...config, fight: { ...fight, durationSec: r.durationSec, durationVariancePct: 0 }, target });
  const total = r.damage.hunter + r.damage.pet;
  const mine = new Map([...r.casts, ...r.petAbilities].map((c) => [c.name, c]));
  const names = [...new Set([...sim.abilities.map((a) => a.name), ...mine.keys()])];
  const yours = total / r.durationSec;
  console.log(`\n${sim.name}, ${sim.iterations} fights of ${fmt(r.durationSec)} sec against level ${target.level ?? "preset"}: ${fmt(sim.dps.mean)} ± ${fmt(sim.dps.error95)} DPS`);
  console.log(`You did ${fmt(yours)} DPS, ${pct(yours / sim.dps.mean)} of the sim${config.level && r.level && config.level !== r.level ? ` (the config is level ${config.level}, you were ${r.level})` : ""}\n`);
  console.log(
    table([
      ["Ability", "Your casts", "Sim casts", "Your DPS", "Sim DPS"],
      ...names.map((name) => {
        const s = sim.abilities.find((a) => a.name === name);
        const m = mine.get(name);
        return [name, m?.casts ? String(m.casts) : "", s ? fmt(s.castsPerFight) : "", m ? fmt(m.damage / r.durationSec) : "", s ? fmt(s.dps) : ""];
      }),
    ]),
  );
}

// Every recorded press, per action: in combat and out, and how often it did nothing.
function printPresses(db: ReturnType<typeof openStore>, hunter: string | undefined): void {
  const guid = hunter && db.query<{ guid: string }, [string, string]>("SELECT guid FROM units WHERE kind = 'hunter' AND (name = ? OR guid = ?)").get(hunter, hunter)?.guid;
  const presses = pressesIn(db, guid || undefined);
  const rows = new Map<string, { name: string; kind: string; combat: number; out: number }>();
  for (const p of presses) {
    const r = rows.get(p.name) ?? { name: p.name, kind: p.kind, combat: 0, out: 0 };
    if (p.combat) r.combat++;
    else r.out++;
    rows.set(p.name, r);
  }
  const sorted = [...rows.values()].sort((a, b) => b.combat + b.out - (a.combat + a.out));
  console.log(`\n${presses.length} button presses recorded${hunter ? ` for ${hunter}` : ""}\n`);
  console.log(
    table([["Action", "Kind", "In combat", "Out of combat", "Share"], ...sorted.map((r) => [r.name, r.kind, String(r.combat), String(r.out), pct((r.combat + r.out) / Math.max(1, presses.length))])], 2),
  );
}

async function main(argv: string[]): Promise<void> {
  const { values: flags, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      iterations: { type: "string" },
      seed: { type: "string" },
      budget: { type: "string" },
      "rotation-budget": { type: "string" },
      rounds: { type: "string" },
      "keep-pet": { type: "boolean" },
      "keep-style": { type: "boolean" },
      pool: { type: "string" },
      out: { type: "string" },
      spec: { type: "string" },
      fight: { type: "string" },
      actor: { type: "string" },
      db: { type: "string" },
      watch: { type: "boolean" },
      sheets: { type: "string" },
      hunter: { type: "string" },
      config: { type: "string" },
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
    const config = await loadConfig(paths[0]!, { fight: flags.fight });
    const result = optimize(game, config, {
      pool: flags.pool?.split(",") ?? poolFor(game, config),
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
  } else if (command === "calibrate" && paths.length === 2) {
    await calibrate(game, paths[0]!, await loadConfig(paths[1]!, flags));
  } else if (command === "beta" && paths.length >= 1) {
    for (const path of paths) await beta(game, await loadConfig(path, flags), path);
  } else if (command === "ingest") {
    await ingestLogs(paths, flags.db ?? DEFAULT_DB, flags.watch ?? false, flags.sheets);
  } else if (command === "claims" && paths.length === 0) {
    printClaims(game, flags.db ?? DEFAULT_DB, flags.hunter);
  } else if (command === "review" && paths.length <= 1) {
    const db = openStore(flags.db ?? DEFAULT_DB);
    if (paths.length === 0) printFights(db, flags.hunter);
    else {
      const r = review(game, db, Number(paths[0]));
      printReview(r);
      if (flags.config) printReviewSim(game, r, await loadConfig(flags.config, { iterations: flags.iterations ?? "500", seed: flags.seed }));
    }
  } else if (command === "presses" && paths.length === 0) {
    printPresses(openStore(flags.db ?? DEFAULT_DB), flags.hunter);
  } else if (command === "log" && paths.length === 1) {
    printLog(await Bun.file(paths[0]!).text(), flags.actor);
  } else if (command === "enchants" && paths.length >= 1) {
    const text = paths.join(" ").toLowerCase();
    const rows = [...game.enchants.values()].filter((e) => e.name.toLowerCase().includes(text));
    console.log(
      table([
        ["Id", "Name", "Stats", "Not simulated"],
        ...rows.map((e) => [
          String(e.id),
          e.name,
          [...Object.entries(e.stats).map(([k, v]) => `${k} ${v}`), ...(e.weaponDamage ? [`weapon damage ${e.weaponDamage}`] : [])].join(", "),
          e.unparsed.join(", "),
        ]),
      ], 4),
    );
  } else if (command === "pets" && paths.length === 1) {
    const config = await loadConfig(paths[0]!, flags);
    const rows = petSweep(game, config);
    console.log(`\nPets for ${config.name ?? paths[0]}, against its own pet on the same fights\n`);
    console.log(
      table([
        ["Pet", "DPS", "vs config", "± 95%"],
        ...rows.map((r) => [r.pet ?? "none", fmt(r.dps), signed(r.delta), fmt(r.error95)]),
      ]),
    );
  } else if (command === "build" && paths.length === 1) {
    const config = await loadConfig(paths[0]!, { fight: flags.fight });
    const iterations = Number(flags.iterations ?? 300);
    const result = optimizeBuild(game, config, {
      build: { iterations, budget: Number(flags.budget ?? 400), mutantsPerRound: 8, climbs: 3, pets: !flags["keep-pet"], styles: !flags["keep-style"], spec: specTree(flags.spec) },
      rotation: { pool: poolFor(game, config), iterations, budget: Number(flags["rotation-budget"] ?? 150), mutantsPerRound: 8, confirmIterations: 3000 },
      rounds: Number(flags.rounds ?? 2),
      taught: TAUGHT,
      confirmIterations: 5000,
      seed: flags.seed ?? "build",
      onProgress: (msg) => console.log(msg),
    });
    const c = result.confirm;
    console.log(`\nBest build: ${describeBuild(game.data, result.build)}`);
    const byTree = game.data.talents.filter((t) => result.build.talents[t.name]);
    console.log(table(byTree.map((t) => [t.tree, t.name, `${result.build.talents[t.name]}/${t.maxRank}`]), 2));
    console.log(`\nOn ${c.after.iterations} fresh fights: start ${fmt(c.before.dps.mean)} DPS, best ${fmt(c.after.dps.mean)} DPS, ${signed(c.delta)} ± ${fmt(c.error95)} (${signed(c.pct, 2)}%)`);
    console.log(`\nBest rotation:\n\n${actionsToml(result.best.rotation.actions)}`);
    print(c.after);
    const out = flags.out;
    if (out) {
      // The parent's pet ability list names its own family's abilities; a new family gets its default.
      const pet = result.build.pet;
      const petAbilities = config.pet?.abilities && pet && pet !== configBuild(config).pet ? defaultPetAbilities(game.data, pet, SimConfig.parse(config).level) : undefined;
      const note = `Found by \`sim build ${paths[0]}\` (${new Date().toISOString().slice(0, 10)}): ${signed(c.pct, 2)}% DPS on ${c.after.iterations} fresh fights.`;
      await Bun.write(out, buildToml(config, paths[0]!, out, result.build, result.best.rotation, note, petAbilities));
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
