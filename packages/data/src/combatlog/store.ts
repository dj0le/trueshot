// A local SQLite store of the combat log events that matter for hunters, filled from WoWCombatLog
// files a chunk at a time: each file's ingested length is kept, so a log still being written is read
// again from where the last ingest stopped. Evidence piles up across sessions for the claims report.
//
// Kept: everything hunters and their pets do; auras and energizes landing on them; auras on
// creatures (armor debuffs others keep up); creature deaths; encounters and COMBATANT_INFO. Hunters
// are the players who fire Auto Shot; pets and hawks are the units whose advanced block names a
// hunter as owner, or that a hunter summons.
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Patch, patchAt } from "../patches";
import { type LogEvent, parseLine } from "./parse";

export const LOGS_CACHE = join(import.meta.dir, "..", "..", "logs-cache");
export const DEFAULT_DB = join(LOGS_CACHE, "logs.sqlite");
// The launch client's log folder (FOREVER_LOGS_DIR overrides).
export const DEFAULT_LOGS_DIR =
  process.env.FOREVER_LOGS_DIR ??
  join(
    process.env.HOME ?? "",
    ".local/share/Steam/steamapps/compatdata/3341133374/pfx/drive_c/Program Files (x86)/World of Warcraft/_forever_/Logs",
  );

const AUTO_SHOT = '75,"Auto Shot"';
// A new fight starts after this long without damage from a hunter or its pets.
const FIGHT_GAP_MS = 10_000;
// A hit this soon after ENCOUNTER_END, on a target hit during the encounter, still belongs to it: a
// sting tick or a swing already under way when the boss died (PLAN.md task 55).
const ENCOUNTER_TAIL_MS = 3_000;
// Read this much of a file at a time.
const CHUNK_BYTES = 16 << 20;

const SCHEMA = `
-- utc_offset_min: the log's clock against UTC; NULL means this machine's zone.
CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, build TEXT, advanced INTEGER, ingested_at TEXT, utc_offset_min INTEGER);
CREATE TABLE IF NOT EXISTS units (guid TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, ts INTEGER NOT NULL, event TEXT NOT NULL,
  src TEXT, src_name TEXT, dst TEXT, dst_name TEXT, spell_id INTEGER, spell_name TEXT, school INTEGER,
  st_guid TEXT, st_owner TEXT, st_hp INTEGER, st_max_hp INTEGER, st_ap INTEGER, st_armor INTEGER,
  st_power_type INTEGER, st_power INTEGER, st_max_power INTEGER, st_level INTEGER, st_x REAL, st_y REAL,
  amount INTEGER, unmitigated INTEGER, overkill INTEGER, dmg_school INTEGER, resisted INTEGER, blocked INTEGER,
  absorbed INTEGER, crit INTEGER, glancing INTEGER, crushing INTEGER, miss_type TEXT, rest TEXT,
  -- The raw line's hash: a line read twice (a copied log, a re-ingest) is stored once.
  line_hash INTEGER NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS events_src ON events (src, ts);
CREATE INDEX IF NOT EXISTS events_dst ON events (dst, ts);
CREATE INDEX IF NOT EXISTS events_spell ON events (spell_id);
CREATE INDEX IF NOT EXISTS events_file ON events (file, ts);
CREATE TABLE IF NOT EXISTS encounters (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER,
  encounter_id INTEGER, name TEXT, difficulty INTEGER, group_size INTEGER, success INTEGER
);
CREATE TABLE IF NOT EXISTS combatants (encounter INTEGER, file TEXT NOT NULL, ts INTEGER NOT NULL, guid TEXT NOT NULL, fields TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fights (
  id INTEGER PRIMARY KEY, file TEXT NOT NULL, hunter TEXT NOT NULL, start_ts INTEGER NOT NULL, end_ts INTEGER NOT NULL,
  encounter INTEGER, label TEXT NOT NULL, damage INTEGER NOT NULL, hits INTEGER NOT NULL
);
`;

export function openStore(path = DEFAULT_DB): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // Stores made before positions were kept.
  const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(events)").all().map((c) => c.name));
  for (const c of ["st_x", "st_y"]) if (!columns.has(c)) db.exec(`ALTER TABLE events ADD COLUMN ${c} REAL`);
  // Stores made before patches were tracked.
  const fileColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(files)").all().map((c) => c.name));
  if (!fileColumns.has("utc_offset_min")) db.exec("ALTER TABLE files ADD COLUMN utc_offset_min INTEGER");
  return db;
}

export type IngestResult = { path: string; bytes: number; lines: number; kept: number; hunters: number; fights: number };

const shortName = (name: string) => name.split("-")[0]!;
const isMeta = (event: string) =>
  event === "COMBAT_LOG_VERSION" || event === "ENCOUNTER_START" || event === "ENCOUNTER_END" || event === "COMBATANT_INFO";

// The new complete lines of a file from `from`, a chunk at a time, with the byte offset after each
// chunk. Lines are cut at newline bytes, so names in any script decode whole.
async function* chunks(path: string, from: number, to: number): AsyncGenerator<{ lines: string[]; end: number }> {
  const file = Bun.file(path);
  const decoder = new TextDecoder();
  let at = from;
  while (at < to) {
    const bytes = new Uint8Array(await file.slice(at, Math.min(to, at + CHUNK_BYTES)).arrayBuffer());
    const last = bytes.lastIndexOf(10);
    if (last < 0) {
      // A line longer than a chunk only ends the read if the file ends here too.
      if (at + bytes.length >= to) return;
      throw new Error(`${path}: a line over ${CHUNK_BYTES} bytes at ${at}`);
    }
    yield { lines: decoder.decode(bytes.subarray(0, last)).split(/\r?\n/), end: at + last + 1 };
    at += last + 1;
  }
}

// Reads what is new in one log file into the store. A file shorter than what was ingested has been
// replaced, and is read again from the start.
// `utcOffsetMin` is the log writer's offset from UTC, for logs from another time zone; left out, the
// file keeps what it had (else this machine's zone).
export async function ingest(db: Database, path: string, utcOffsetMin?: number): Promise<IngestResult> {
  const size = Bun.file(path).size;
  const seen = db.query<{ offset: number }, [string]>("SELECT offset FROM files WHERE path = ?").get(path);
  let from = seen?.offset ?? 0;
  if (from > size) {
    forget(db, path);
    from = 0;
  }
  const result: IngestResult = { path, bytes: size - from, lines: 0, kept: 0, hunters: 0, fights: 0 };
  if (utcOffsetMin !== undefined) {
    db.run("INSERT INTO files (path, offset, utc_offset_min) VALUES (?, 0, ?) ON CONFLICT (path) DO UPDATE SET utc_offset_min = excluded.utc_offset_min", [path, utcOffsetMin]);
  }
  if (from === size) return result;

  const units = new Map(db.query<{ guid: string; kind: string }, []>("SELECT guid, kind FROM units").all().map((u) => [u.guid, u.kind]));
  const hunters = new Set([...units].filter(([, k]) => k === "hunter").map(([g]) => g));

  // First pass: the players who fire Auto Shot in the new part, so their earlier events count too.
  for await (const { lines } of chunks(path, from, size)) {
    for (const line of lines) {
      if (!line.includes(AUTO_SHOT)) continue;
      const e = parseLine(line);
      if (e?.spell?.id === 75 && e.source?.guid.startsWith("Player-")) hunters.add(e.source.guid);
    }
  }

  const addUnit = db.query("INSERT INTO units (guid, name, kind, owner) VALUES (?, ?, ?, ?) ON CONFLICT (guid) DO UPDATE SET name = excluded.name, kind = excluded.kind, owner = excluded.owner");
  const markPet = (guid: string, name: string, owner: string) => {
    if (units.get(guid) === "pet" || !hunters.has(owner)) return;
    units.set(guid, "pet");
    addUnit.run(guid, shortName(name), "pet", owner);
  };
  const insert = db.query(
    `INSERT INTO events (file, ts, event, src, src_name, dst, dst_name, spell_id, spell_name, school,
      st_guid, st_owner, st_hp, st_max_hp, st_ap, st_armor, st_power_type, st_power, st_max_power, st_level, st_x, st_y,
      amount, unmitigated, overkill, dmg_school, resisted, blocked, absorbed, crit, glancing, crushing, miss_type, rest, line_hash)
     VALUES (${Array(35).fill("?").join(", ")}) ON CONFLICT (line_hash) DO NOTHING`,
  );
  const startEncounter = db.query("INSERT INTO encounters (file, start_ts, encounter_id, name, difficulty, group_size) VALUES (?, ?, ?, ?, ?, ?)");
  const endEncounter = db.query(
    "UPDATE encounters SET end_ts = ?, success = ? WHERE id = (SELECT id FROM encounters WHERE file = ? AND encounter_id = ? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1)",
  );
  const addCombatant = db.query(
    "INSERT INTO combatants (encounter, file, ts, guid, fields) VALUES ((SELECT id FROM encounters WHERE file = ? AND end_ts IS NULL ORDER BY start_ts DESC LIMIT 1), ?, ?, ?, ?)",
  );
  const setOffset = db.query(
    "INSERT INTO files (path, offset, ingested_at) VALUES (?, ?, datetime('now')) ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, ingested_at = excluded.ingested_at",
  );
  const setVersion = db.query("UPDATE files SET build = ?, advanced = ? WHERE path = ?");

  for (const h of hunters) {
    if (units.get(h) !== "hunter") {
      units.set(h, "hunter");
      addUnit.run(h, "", "hunter", "");
    }
  }
  const named = new Set<string>();
  const ours = (guid: string | undefined) => guid !== undefined && units.has(guid);

  const keep = (e: LogEvent): boolean => {
    if (isMeta(e.event)) return false;
    if (e.event === "UNIT_DIED") return e.dest?.guid.startsWith("Creature-") ?? false;
    if (ours(e.source?.guid)) return true;
    if (ours(e.dest?.guid)) return e.event.startsWith("SPELL_AURA_") || e.event.endsWith("ENERGIZE");
    return e.event.startsWith("SPELL_AURA_") && (e.dest?.guid.startsWith("Creature-") ?? false);
  };

  for await (const { lines, end } of chunks(path, from, size)) {
    db.transaction(() => {
      for (const line of lines) {
        if (!line) continue;
        result.lines++;
        const e = parseLine(line);
        if (!e) continue;
        const f = e.fields;
        if (e.event === "COMBAT_LOG_VERSION") {
          setOffset.run(path, from);
          setVersion.run(f[4] ?? null, f[2] === "1" ? 1 : 0, path);
        } else if (e.event === "ENCOUNTER_START") startEncounter.run(path, e.timeMs, Number(f[0]), f[1] ?? "", Number(f[2]), Number(f[3]));
        else if (e.event === "ENCOUNTER_END") endEncounter.run(e.timeMs, f[4] === "1" ? 1 : 0, path, Number(f[0]));
        else if (e.event === "COMBATANT_INFO" && hunters.has(f[0]!)) addCombatant.run(path, path, e.timeMs, f[0]!, JSON.stringify(f));

        // Pets: an advanced block naming a hunter as owner, or a hunter's summon.
        if (e.state?.owner) {
          const unit = e.state.guid === e.source?.guid ? e.source : e.state.guid === e.dest?.guid ? e.dest : undefined;
          if (unit) markPet(unit.guid, unit.name, e.state.owner);
        }
        if (e.event === "SPELL_SUMMON" && e.dest && hunters.has(e.source?.guid ?? "")) markPet(e.dest.guid, e.dest.name, e.source!.guid);
        if (e.source && hunters.has(e.source.guid) && !named.has(e.source.guid)) {
          named.add(e.source.guid);
          db.run("UPDATE units SET name = ? WHERE guid = ?", [shortName(e.source.name), e.source.guid]);
        }

        if (!keep(e)) continue;
        const s = e.state;
        const d = e.damage;
        result.kept += insert.run(
          path, e.timeMs, e.event,
          e.source?.guid ?? null, e.source ? shortName(e.source.name) : null,
          e.dest?.guid ?? null, e.dest ? shortName(e.dest.name) : null,
          e.spell?.id ?? null, e.spell?.name ?? null, e.spell?.school ?? null,
          s?.guid ?? null, s?.owner ?? null, s?.health ?? null, s?.maxHealth ?? null, s?.attackPower ?? null, s?.armor ?? null,
          s?.powerType ?? null, s?.power ?? null, s?.maxPower ?? null, s?.level ?? null, s?.x ?? null, s?.y ?? null,
          d?.amount ?? null, d?.unmitigated ?? null, d?.overkill ?? null, d?.school ?? null, d?.resisted ?? null, d?.blocked ?? null,
          d?.absorbed ?? null, d ? Number(d.critical) : null, d ? Number(d.glancing) : null, d ? Number(d.crushing) : null,
          e.missType ?? null, e.rest.length ? e.rest.join(",") : null, BigInt.asIntN(64, BigInt(Bun.hash(line))),
        ).changes;
      }
      setOffset.run(path, end);
    })();
  }
  result.hunters = hunters.size;
  result.fights = rebuildFights(db, path);
  return result;
}

// Units left out of the claims (logs-cache/exclude.toml: pets tamed only to learn an ability, and the
// like), by GUID.
export const EXCLUDE_PATH = join(LOGS_CACHE, "exclude.toml");
export function excludedUnits(path = EXCLUDE_PATH): Set<string> {
  if (!existsSync(path)) return new Set();
  const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as { unit?: { guid: string }[] };
  return new Set((parsed.unit ?? []).map((u) => u.guid));
}

// The patch of a stored line, from its file's clock offset and its stamp.
export function patchOfLine(db: Database, patches: Patch[]): (file: string, ts: number) => Patch {
  const offsets = new Map(db.query<{ path: string; utc_offset_min: number | null }, []>("SELECT path, utc_offset_min FROM files").all().map((f) => [f.path, f.utc_offset_min]));
  return (file, ts) => patchAt(patches, ts, offsets.get(file));
}

// Drops everything read from one file.
export function forget(db: Database, path: string): void {
  db.transaction(() => {
    for (const table of ["events", "encounters", "combatants", "fights", "files"]) {
      db.run(`DELETE FROM ${table} WHERE ${table === "files" ? "path" : "file"} = ?`, [path]);
    }
  })();
}

// Each hunter's fights in one file: an encounter's whole window (and its tail, ENCOUNTER_TAIL_MS),
// else a run of damage by the hunter and its pets on creatures with no gap over FIGHT_GAP_MS.
// Labelled by the encounter, or by the creature that took the most damage.
export function rebuildFights(db: Database, path: string): number {
  type Hit = { ts: number; hunter: string; dst_name: string; amount: number | null };
  const hits = db
    .query<Hit, [string]>(
      `SELECT e.ts, CASE u.kind WHEN 'hunter' THEN u.guid ELSE u.owner END AS hunter, e.dst_name, e.amount
       FROM events e JOIN units u ON u.guid = e.src
       WHERE e.file = ? AND e.dst LIKE 'Creature-%' AND (e.event LIKE '%_DAMAGE' OR e.event LIKE '%_MISSED')
       ORDER BY e.ts`,
    )
    .all(path);
  const encounters = db
    .query<{ id: number; start_ts: number; end_ts: number | null; name: string }, [string]>("SELECT id, start_ts, end_ts, name FROM encounters WHERE file = ?")
    .all(path);
  const encounterAt = (ts: number) => encounters.find((x) => ts >= x.start_ts && ts <= (x.end_ts ?? Infinity));

  type Fight = { hunter: string; start: number; end: number; encounter: { id: number; name: string } | undefined; damage: number; hits: number; byTarget: Map<string, number> };
  const open = new Map<string, Fight>();
  const done: Fight[] = [];
  // Each hunter's last encounter fight, for the hits in its tail.
  const lastEncounter = new Map<string, Fight>();
  for (const h of hits) {
    const enc = encounterAt(h.ts);
    if (!enc) {
      const last = lastEncounter.get(h.hunter);
      const ended = last && encounters.find((x) => x.id === last.encounter!.id)?.end_ts;
      if (last && ended != null && h.ts - ended <= ENCOUNTER_TAIL_MS && last.byTarget.has(h.dst_name)) {
        last.end = h.ts;
        last.hits++;
        last.damage += h.amount ?? 0;
        last.byTarget.set(h.dst_name, last.byTarget.get(h.dst_name)! + (h.amount ?? 0));
        continue;
      }
    }
    let f = open.get(h.hunter);
    if (f && (f.encounter?.id !== enc?.id || (!enc && h.ts - f.end > FIGHT_GAP_MS))) {
      done.push(f);
      f = undefined;
    }
    if (!f) {
      f = { hunter: h.hunter, start: h.ts, end: h.ts, encounter: enc, damage: 0, hits: 0, byTarget: new Map() };
      open.set(h.hunter, f);
      if (enc) lastEncounter.set(h.hunter, f);
    }
    f.end = h.ts;
    f.hits++;
    f.damage += h.amount ?? 0;
    f.byTarget.set(h.dst_name, (f.byTarget.get(h.dst_name) ?? 0) + (h.amount ?? 0));
  }
  done.push(...open.values());

  const add = db.query("INSERT INTO fights (file, hunter, start_ts, end_ts, encounter, label, damage, hits) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    db.run("DELETE FROM fights WHERE file = ?", [path]);
    for (const f of done) {
      const top = [...f.byTarget].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      add.run(path, f.hunter, f.start, f.end, f.encounter?.id ?? null, f.encounter?.name ?? top, f.damage, f.hits);
    }
  })();
  return done.length;
}
