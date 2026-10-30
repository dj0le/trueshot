// Reads a WoW Classic combat log (WoWCombatLog-*.txt, COMBAT_LOG_VERSION 22) into typed events. With
// advanced logging on, damage and cast events carry the acting unit's state: its owner (for pets),
// health, attack power, armor, power and level. Only the events the sim calibrates against are
// decoded; the rest keep their raw fields.
//
// Line: "10/17/2026 18:28:53.062-6  SWING_DAMAGE,<source>,<dest>,<prefix>,<advanced>,<suffix>"
//   source and dest: guid, name, flags, raid flags
//   prefix: nothing for SWING_, spell id, name and school for RANGE_, SPELL_ and SPELL_PERIODIC_
//   advanced (19 fields): unit guid, owner guid, health, max health, attack power, spell power,
//     armor, absorb, two unknown, power type, power, max power, power cost, x, y, map, facing, level
//     (a player's item level instead: a naked beta hunter logs 8, the same one geared 34)
//   damage suffix: amount, amount before armor and resists, overkill, school, resisted, blocked,
//     absorbed, critical, glancing, crushing
//   missed suffix: miss type (MISS, DODGE, PARRY, BLOCK, RESIST, ABSORB, ...), offhand, amount
//
// SWING_DAMAGE's advanced block describes the attacker; SWING_DAMAGE_LANDED's the unit that was hit.

export type Unit = { guid: string; name: string; flags: number };

export type UnitState = {
  guid: string;
  // The owning player's guid for pets and guardians, else empty.
  owner: string;
  health: number;
  maxHealth: number;
  attackPower: number;
  spellPower: number;
  armor: number;
  powerType: number;
  power: number;
  maxPower: number;
  // Map position in yards.
  x: number;
  y: number;
  // A creature's or pet's level; a player's average item level.
  level: number;
};

export type Damage = {
  amount: number;
  // Before armor, resists, blocks and absorbs; crits and modifiers already applied.
  unmitigated: number;
  overkill: number;
  school: number;
  resisted: number;
  blocked: number;
  absorbed: number;
  critical: boolean;
  glancing: boolean;
  crushing: boolean;
};

export type LogSpell = { id: number; name: string; school: number };

export type LogEvent = {
  // Milliseconds since the log's first line.
  timeMs: number;
  event: string;
  source?: Unit;
  dest?: Unit;
  spell?: LogSpell;
  state?: UnitState;
  damage?: Damage;
  missType?: string;
  // Every field after the event name, as written.
  fields: string[];
  // The fields after the source, dest, prefix and advanced block: an aura's BUFF or DEBUFF and
  // stacks, an energize's amount and power type. Empty for damage and misses, which decode them.
  rest: string[];
};

const NO_GUID = "0000000000000000";
const GUID = /^(?:[A-Z][A-Za-z]*-[\dA-F-]+|0000000000000000)$/;
const ADVANCED_FIELDS = 19;

// Splits on commas outside double quotes and brackets (COMBATANT_INFO nests lists in () and []).
export function splitFields(text: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  let depth = 0;
  for (const c of text) {
    if (quoted) {
      if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === "(" || c === "[") {
      depth++;
      field += c;
    } else if (c === ")" || c === "]") {
      depth--;
      field += c;
    } else if (c === "," && depth === 0) {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out;
}

const num = (s: string | undefined) => (s === undefined || s === "nil" ? 0 : Number(s));
const flag = (s: string | undefined) => s !== undefined && s !== "nil" && s !== "0";

// "10/17/2026 18:28:53.062-6" in ms, as wall-clock time (the zone suffix is dropped).
export function parseTime(stamp: string): number {
  const m = /^(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)\.(\d+)/.exec(stamp);
  if (!m) throw new Error(`combat log: bad timestamp "${stamp}"`);
  const [, mo, d, y, h, mi, s, ms] = m.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!, ms!);
}

const unit = (f: string[], at: number): Unit => ({ guid: f[at]!, name: f[at + 1]!, flags: Number(f[at + 2]) });

function state(f: string[], at: number): UnitState {
  return {
    guid: f[at]!,
    owner: f[at + 1] === NO_GUID ? "" : f[at + 1]!,
    health: num(f[at + 2]),
    maxHealth: num(f[at + 3]),
    attackPower: num(f[at + 4]),
    spellPower: num(f[at + 5]),
    armor: num(f[at + 6]),
    powerType: num(f[at + 10]),
    power: num(f[at + 11]),
    maxPower: num(f[at + 12]),
    x: num(f[at + 14]),
    y: num(f[at + 15]),
    level: num(f[at + 18]),
  };
}

function damage(f: string[], at: number): Damage {
  return {
    amount: num(f[at]),
    unmitigated: num(f[at + 1]),
    overkill: num(f[at + 2]),
    school: num(f[at + 3]),
    resisted: num(f[at + 4]),
    blocked: num(f[at + 5]),
    absorbed: num(f[at + 6]),
    critical: flag(f[at + 7]),
    glancing: flag(f[at + 8]),
    crushing: flag(f[at + 9]),
  };
}

// Events with the source, dest, prefix, advanced and suffix layout, by prefix length.
const PREFIX: [string, number][] = [
  ["SWING_", 0],
  ["RANGE_", 3],
  ["SPELL_PERIODIC_", 3],
  ["SPELL_", 3],
];
// Suffixes that carry an advanced block.
const ADVANCED_SUFFIXES = new Set(["DAMAGE", "DAMAGE_LANDED", "HEAL", "CAST_SUCCESS", "ENERGIZE", "PERIODIC_HEAL"]);

export function parseLine(line: string, startMs = 0): LogEvent | null {
  const split = line.indexOf("  ");
  if (split < 0) return null;
  const [event, ...fields] = splitFields(line.slice(split + 2).trimEnd());
  const out: LogEvent = { timeMs: parseTime(line.slice(0, split)) - startMs, event: event!, fields, rest: fields };
  // Every combat event starts with source and dest (UNIT_DIED too); meta lines like ENCOUNTER_START do not.
  if (fields.length < 8 || !GUID.test(fields[0]!)) return out;
  out.source = unit(fields, 0);
  out.dest = unit(fields, 4);
  const prefix = PREFIX.find(([p]) => event!.startsWith(p));
  if (!prefix) return out;
  const [p, n] = prefix;
  if (n) out.spell = { id: num(fields[8]), name: fields[9]!, school: Number(fields[10]) };
  const suffix = event!.slice(p.length);
  let at = 8 + n;
  if (ADVANCED_SUFFIXES.has(suffix) && fields.length >= at + ADVANCED_FIELDS) {
    out.state = state(fields, at);
    at += ADVANCED_FIELDS;
  }
  if (suffix === "DAMAGE" || suffix === "DAMAGE_LANDED") out.damage = damage(fields, at);
  else if (suffix === "MISSED") out.missType = fields[at] ?? "";
  out.rest = out.damage || out.missType !== undefined ? [] : fields.slice(at);
  return out;
}

export function parseLog(text: string): LogEvent[] {
  const events: LogEvent[] = [];
  let start: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    if (start === undefined) start = parseTime(line.slice(0, line.indexOf("  ")));
    const e = parseLine(line, start);
    if (e) events.push(e);
  }
  return events;
}
