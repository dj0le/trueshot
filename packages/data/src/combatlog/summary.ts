// Per-unit damage summaries from a parsed combat log: who hit, with what, and for how much, with the
// attacker's level and attack power where advanced logging recorded them.
import type { LogEvent } from "./parse";

export type AbilityLog = {
  name: string;
  hits: number;
  crits: number;
  glances: number;
  misses: number;
  // Misses by type (MISS, DODGE, PARRY, ...).
  missTypes: Record<string, number>;
  damage: number;
  ticks: number;
};

export type ActorLog = {
  guid: string;
  // The name before its first dash; logs append realm and other suffixes that change line to line.
  name: string;
  // The owning player's guid for a pet, else empty.
  owner: string;
  levels: Set<number>;
  abilities: Map<string, AbilityLog>;
};

const AUTO_SHOT = 75;
const shortName = (name: string) => name.split("-")[0]!;

// The ability a damage or miss event belongs to: the spell, or the swing.
const abilityOf = (e: LogEvent) => (e.spell ? e.spell.name : e.event.startsWith("SWING_") ? "Melee" : e.event);

export function actors(events: LogEvent[]): Map<string, ActorLog> {
  const out = new Map<string, ActorLog>();
  const actor = (guid: string, name: string): ActorLog => {
    let a = out.get(guid);
    if (!a) out.set(guid, (a = { guid, name: shortName(name), owner: "", levels: new Set(), abilities: new Map() }));
    return a;
  };
  for (const e of events) {
    if (!e.source || e.event.endsWith("_LANDED")) continue;
    const isDamage = e.damage !== undefined;
    const isMiss = e.missType !== undefined;
    if (!isDamage && !isMiss) {
      // Summons name their pet's owner too.
      if (e.event === "SPELL_SUMMON" && e.dest) actor(e.dest.guid, e.dest.name).owner ||= e.source.guid;
      continue;
    }
    const a = actor(e.source.guid, e.source.name);
    if (e.state?.guid === e.source.guid) {
      if (e.state.owner) a.owner = e.state.owner;
      if (e.state.level) a.levels.add(e.state.level);
    }
    const name = abilityOf(e);
    let s = a.abilities.get(name);
    if (!s) a.abilities.set(name, (s = { name, hits: 0, crits: 0, glances: 0, misses: 0, missTypes: {}, damage: 0, ticks: 0 }));
    if (e.damage) {
      s.damage += e.damage.amount;
      if (e.event.includes("PERIODIC")) s.ticks++;
      if (e.damage.critical) s.crits++;
      else if (e.damage.glancing) s.glances++;
      else s.hits++;
    } else {
      s.misses++;
      s.missTypes[e.missType!] = (s.missTypes[e.missType!] ?? 0) + 1;
    }
  }
  return out;
}

// Players who fired Auto Shot or own a hunter pet (Pet- guids; warlock demons are pets too, but
// rarely log damage in hunter calibration logs), with their pets. A hunter seen only through a pet
// is null.
export function hunters(all: Map<string, ActorLog>, events: LogEvent[]): { guid: string; hunter: ActorLog | null; pets: ActorLog[] }[] {
  const shooters = events.filter((e) => e.spell?.id === AUTO_SHOT && e.source?.guid.startsWith("Player-")).map((e) => e.source!.guid);
  const owners = [...all.values()].filter((a) => a.guid.startsWith("Pet-") && a.owner).map((a) => a.owner);
  return [...new Set([...shooters, ...owners])].map((guid) => ({
    guid,
    hunter: all.get(guid) ?? null,
    pets: [...all.values()].filter((a) => a.owner === guid),
  }));
}

// One damage event by a unit, with its state at the time.
export type HitLog = {
  timeMs: number;
  ability: string;
  target: string;
  amount: number;
  unmitigated: number;
  critical: boolean;
  glancing: boolean;
  level: number;
  attackPower: number;
};

export function hitsBy(events: LogEvent[], guid: string): HitLog[] {
  return events
    .filter((e) => e.source?.guid === guid && e.damage && !e.event.endsWith("_LANDED"))
    .map((e) => ({
      timeMs: e.timeMs,
      ability: abilityOf(e),
      target: shortName(e.dest!.name),
      amount: e.damage!.amount,
      unmitigated: e.damage!.unmitigated,
      critical: e.damage!.critical,
      glancing: e.damage!.glancing,
      level: e.state?.guid === guid ? e.state.level : 0,
      attackPower: e.state?.guid === guid ? e.state.attackPower : 0,
    }));
}
