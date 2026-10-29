// Character sheets from the Trueshot addon (packages/addon): its SavedVariables file holds
// login sessions, each anchored at a whole second of the local wall clock, with rows written
// whenever the sheet changed. Rows go into the store with the combat log's timestamps, so a claim
// can ask what the hunter's level, ranged attack power or bow speed was at any event.
import type { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LOGS_DIR } from "./store";
import { parseTime } from "./parse";

export type Sheet = {
  guid: string;
  ts: number;
  level: number;
  // Ranged attack power with buffs; melee attack power.
  rap: number;
  ap: number;
  // The bow's current speed (haste included) and damage range on the sheet.
  rangedSpeed: number;
  rangedMin: number;
  rangedMax: number;
  rangedCritPct: number;
  meleeCritPct: number;
  hitPct: number;
  agility: number;
  buffs: number[];
  // Worn items as "slot:id:enchant:suffix".
  gear: string[];
  // Ranks in talent order per tree.
  talents: string;
  pet: { family: string; level: number; ap: number; speed: number; min: number; max: number } | null;
};

type LuaValue = string | number | boolean | null | LuaValue[] | { [k: string]: LuaValue };

// Reads the table literals WoW writes to SavedVariables: `Name = { ["k"] = v, v, -- [1] ... }`.
export function parseSavedVariables(text: string): Record<string, LuaValue> {
  let i = 0;
  const space = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (text.startsWith("--", i)) {
        const end = text.indexOf("\n", i);
        i = end < 0 ? text.length : end;
      } else return;
    }
  };
  const fail = (what: string): never => {
    throw new Error(`SavedVariables: ${what} at ${i}: ${text.slice(i, i + 30)}`);
  };
  const string = (): string => {
    let out = "";
    i++;
    while (text[i] !== '"') {
      if (i >= text.length) fail("unterminated string");
      if (text[i] === "\\") {
        const c = text[++i]!;
        if (/\d/.test(c)) {
          const digits = /^\d{1,3}/.exec(text.slice(i))![0];
          out += String.fromCharCode(Number(digits));
          i += digits.length;
          continue;
        }
        out += c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "\n" ? "\n" : c;
        i++;
      } else out += text[i++];
    }
    i++;
    return out;
  };
  const value = (): LuaValue => {
    space();
    const c = text[i];
    if (c === '"') return string();
    if (c === "{") return table();
    const word = /^(-?[\d.]+(?:e[-+]?\d+)?|true|false|nil)/.exec(text.slice(i))?.[0] ?? fail("bad value");
    i += word.length;
    return word === "true" ? true : word === "false" ? false : word === "nil" ? null : Number(word);
  };
  const table = (): LuaValue => {
    i++;
    const list: LuaValue[] = [];
    const keyed: Record<string, LuaValue> = {};
    let hasKeys = false;
    for (;;) {
      space();
      if (text[i] === "}") {
        i++;
        break;
      }
      if (text[i] === "[") {
        i++;
        space();
        const key = text[i] === '"' ? string() : String(value());
        space();
        if (text[i] !== "]") fail("expected ]");
        i++;
        space();
        if (text[i] !== "=") fail("expected =");
        i++;
        keyed[key] = value();
        hasKeys = true;
      } else list.push(value());
      space();
      if (text[i] === "," || text[i] === ";") i++;
    }
    return hasKeys ? { ...Object.fromEntries(list.map((v, n) => [String(n + 1), v])), ...keyed } : list;
  };
  const out: Record<string, LuaValue> = {};
  for (space(); i < text.length; space()) {
    const name = /^[A-Za-z_]\w*/.exec(text.slice(i))?.[0] ?? fail("expected a name");
    i += name.length;
    space();
    if (text[i] !== "=") fail("expected =");
    i++;
    out[name] = value();
  }
  return out;
}

const n = (x: string | undefined) => (x === undefined || x === "" ? 0 : Number(x));

// One row's "key=value;..." text as a sheet at the given time.
export function sheetOf(guid: string, ts: number, row: string): Sheet {
  const v = Object.fromEntries(row.split(";").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  return {
    guid,
    ts,
    level: n(v.level),
    rap: n(v.rap),
    ap: n(v.ap),
    rangedSpeed: n(v.rspeed),
    rangedMin: n(v.rmin),
    rangedMax: n(v.rmax),
    rangedCritPct: n(v.rcrit),
    meleeCritPct: n(v.mcrit),
    hitPct: n(v.hit),
    agility: n(v.agi),
    buffs: v.buffs ? v.buffs.split(",").map(Number) : [],
    gear: v.gear ? v.gear.split(",") : [],
    talents: v.talents ?? "",
    pet: v.pet
      ? { family: v.pet, level: n(v.petlevel), ap: n(v.petap), speed: n(v.petspeed), min: n(v.petmin), max: n(v.petmax) }
      : null,
  };
}

// Every sheet in a SavedVariables file, on the combat log's clock.
export function readSheets(text: string): Sheet[] {
  const db = parseSavedVariables(text).TrueshotDB as { sessions?: { wall: string; guid: string; rows: string[] }[] } | undefined;
  return (db?.sessions ?? []).flatMap((s) => {
    const anchor = parseTime(`${s.wall}.000`);
    return s.rows.map((row) => {
      const t = Number(/^t=(-?\d+)/.exec(row)?.[1] ?? 0);
      return sheetOf(s.guid, anchor + t, row);
    });
  });
}

// The addon's SavedVariables in every account of the launch client (TRUESHOT_SV overrides).
export function defaultSheetFiles(): string[] {
  if (process.env.TRUESHOT_SV) return [process.env.TRUESHOT_SV];
  const accounts = join(dirname(DEFAULT_LOGS_DIR), "WTF", "Account");
  try {
    return readdirSync(accounts)
      .map((a) => join(accounts, a, "SavedVariables", "Trueshot.lua"))
      .filter((p) => Bun.file(p).size > 0);
  } catch {
    return [];
  }
}

const SCHEMA = "CREATE TABLE IF NOT EXISTS sheets (guid TEXT NOT NULL, ts INTEGER NOT NULL, sheet TEXT NOT NULL, PRIMARY KEY (guid, ts));";

// Stores a SavedVariables file's sheets; ones already stored are kept. Returns how many were new.
export async function ingestSheets(db: Database, path: string): Promise<number> {
  db.exec(SCHEMA);
  const add = db.query("INSERT INTO sheets (guid, ts, sheet) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
  const sheets = readSheets(await Bun.file(path).text());
  let added = 0;
  db.transaction(() => {
    for (const s of sheets) {
      added += add.run(s.guid, s.ts, JSON.stringify(s)).changes;
    }
  })();
  return added;
}

// Buffs come and go all through play, so a sheet older than this means the addon was not running.
const MAX_SHEET_AGE_MS = 3 * 3600_000;

// A lookup of each hunter's sheet as it stood at a time, from the store.
export function sheetsAt(db: Database): (guid: string, ts: number) => Sheet | undefined {
  db.exec(SCHEMA);
  const byGuid = new Map<string, Sheet[]>();
  for (const r of db.query<{ sheet: string }, []>("SELECT sheet FROM sheets ORDER BY ts").all()) {
    const s = JSON.parse(r.sheet) as Sheet;
    byGuid.set(s.guid, [...(byGuid.get(s.guid) ?? []), s]);
  }
  return (guid, ts) => {
    const list = byGuid.get(guid);
    if (!list || list[0]!.ts > ts) return undefined;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid]!.ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return ts - list[lo]!.ts <= MAX_SHEET_AGE_MS ? list[lo] : undefined;
  };
}
