// Gear presets from the GearQuest Forever addon's hunter picks: for each spec, level and tier, the
// ranked item per slot that covers that level, written as a config to `extends` from.
//
//   bun run gearquest [--levels 30,60] [--faction Alliance|Horde]
//
// Tiers by the addon's rank among the items this sim can wear: best is the first, good the fourth,
// average the eighth (a fresh character's quest greens). Items the sim does not have (server-only
// Forever items) and random-suffix items without a suffix id are skipped. Rings and trinkets take
// two different items; a two-handed main hand leaves the off hand empty.
//
// The addon lives in the WoW install (GEARQUEST_DIR overrides the default Steam/Proton path below).
// Its picks rank Classic BiS stat weights, not Forever-tuned ones.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ITEMS_PATH, SUFFIXES_PATH } from "./index";
import type { Item, Suffix } from "./schema";

const DEFAULT_DIR = join(
  process.env.HOME ?? "",
  ".local/share/Steam/steamapps/compatdata/3341133374/pfx/drive_c/Program Files (x86)/World of Warcraft/_classic_beta_/Interface/AddOns/GearQuestForever_HUNTER",
);
const OUT_DIR = join(import.meta.dir, "..", "..", "..", "configs", "gear", "gearquest");

const SPECS: Record<string, string> = { bm: "beast_mastery", mm: "marksmanship", sv: "survival" };
const TIERS: Record<string, number> = { best: 1, good: 4, average: 8 };
// The addon's slots, and ours (two of each for rings and trinkets).
const SLOTS: Record<string, string[]> = {
  Head: ["head"],
  Neck: ["neck"],
  Shoulder: ["shoulder"],
  Back: ["back"],
  Chest: ["chest"],
  Wrist: ["wrist"],
  Hands: ["hands"],
  Waist: ["waist"],
  Legs: ["legs"],
  Feet: ["feet"],
  Finger: ["finger1", "finger2"],
  Trinket: ["trinket1", "trinket2"],
  MainHand: ["mainHand"],
  SecondaryHand: ["offHand"],
  Ranged: ["ranged"],
};
// Inventory types each of our slots takes (as the engine's SLOT_TYPES).
const FITS: Record<string, number[]> = {
  head: [1], neck: [2], shoulder: [3], back: [16], chest: [5, 20], wrist: [9], hands: [10], waist: [6], legs: [7], feet: [8],
  finger1: [11], finger2: [11], trinket1: [12], trinket2: [12], mainHand: [13, 17, 21], offHand: [13, 14, 22, 23], ranged: [15, 25, 26],
};
const TWO_HAND = 17;

export type Pick = { itemId: number; slot: string; minLevel: number; maxLevel: number; rank: number; spec: string; faction: string; suffixId?: number; suffix?: string };

// Rows of GQ.Data.hunterPicks: {itemId,"Slot",minLevel,maxLevel,rank,"spec","faction",score,...}.
export function parsePicks(lua: string): Pick[] {
  const start = lua.indexOf("GQ.Data.hunterPicks");
  if (start < 0) throw new Error("gearquest: no GQ.Data.hunterPicks table");
  const row = /\{(\d+),"(\w+)",(\d+),(\d+),(\d+),"(\w+)","(\w+)",[\d.]+([^}]*)\}/g;
  const picks: Pick[] = [];
  for (const m of lua.slice(start).matchAll(row)) {
    const extra = m[8] ?? "";
    const suffixId = /suffixId=(\d+)/.exec(extra)?.[1];
    const suffix = /suffix="([^"]*)"/.exec(extra)?.[1];
    picks.push({
      itemId: Number(m[1]),
      slot: m[2]!,
      minLevel: Number(m[3]),
      maxLevel: Number(m[4]),
      rank: Number(m[5]),
      spec: m[6]!,
      faction: m[7]!,
      ...(suffixId ? { suffixId: Number(suffixId) } : {}),
      ...(suffix ? { suffix } : {}),
    });
  }
  return picks;
}

export type Preset = { items: Record<string, number>; suffixes: Record<string, number>; names: Record<string, string> };

// One spec, level and tier: per slot, the n-th wearable pick by rank (n from the tier).
export function preset(picks: Pick[], items: Map<number, Item>, suffixes: Map<number, Suffix>, spec: string, faction: string, level: number, n: number): Preset {
  const out: Preset = { items: {}, suffixes: {}, names: {} };
  for (const [theirs, ours] of Object.entries(SLOTS)) {
    const wearable = picks
      .filter((p) => p.slot === theirs && p.spec === spec && p.faction === faction && p.minLevel <= level && level <= p.maxLevel)
      .sort((a, b) => a.rank - b.rank)
      .filter((p) => {
        const item = items.get(p.itemId);
        if (!item || item.requiredLevel > level || !FITS[ours[0]!]!.includes(item.inventoryType)) return false;
        return p.suffix === undefined || (p.suffixId !== undefined && suffixes.has(p.suffixId));
      })
      .filter((p, i, all) => all.findIndex((q) => q.itemId === p.itemId) === i);
    ours.forEach((slot, k) => {
      const p = wearable[Math.min(n - 1 + k, wearable.length - 1)];
      if (!p || (slot === "finger2" || slot === "trinket2") && p.itemId === out.items[ours[0]!]) return;
      if (slot === "offHand" && items.get(out.items.mainHand ?? 0)?.inventoryType === TWO_HAND) return;
      out.items[slot] = p.itemId;
      out.names[slot] = `${items.get(p.itemId)!.name}${p.suffixId ? ` ${suffixes.get(p.suffixId)!.name}` : ""}`;
      if (p.suffixId) out.suffixes[slot] = p.suffixId;
    });
  }
  return out;
}

function toml(p: Preset, spec: string, level: number, tier: string, faction: string): string {
  const lines = [
    `# GearQuest Forever ${tier} gear for a level ${level} ${spec} hunter (${faction}), written by \`bun run gearquest\`.`,
    `# Extend it and set level = ${level}; Classic stat weights rank the addon's picks.`,
    "",
    "[gear.items]",
    ...Object.entries(p.items).map(([slot, id]) => `${slot} = ${id}  # ${p.names[slot]}`),
  ];
  if (Object.keys(p.suffixes).length) lines.push("", "[gear.suffixes]", ...Object.entries(p.suffixes).map(([slot, id]) => `${slot} = ${id}`));
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({ args: process.argv.slice(2), options: { levels: { type: "string" }, faction: { type: "string" } } });
  const levels = (values.levels ?? "30,60").split(",").map(Number);
  const faction = values.faction ?? "Alliance";
  const dir = process.env.GEARQUEST_DIR ?? DEFAULT_DIR;
  const lua = await Bun.file(join(dir, "Data.Hunter.generated.lua")).text();
  const picks = parsePicks(lua);
  const items = new Map(((await Bun.file(ITEMS_PATH).json()) as Item[]).map((i) => [i.id, i]));
  const suffixes = new Map(((await Bun.file(SUFFIXES_PATH).json()) as Suffix[]).map((s) => [s.id, s]));
  await mkdir(OUT_DIR, { recursive: true });
  for (const [short, spec] of Object.entries(SPECS)) {
    for (const level of levels) {
      for (const [tier, n] of Object.entries(TIERS)) {
        const p = preset(picks, items, suffixes, spec, faction, level, n);
        const file = join(OUT_DIR, `${short}-${level}-${tier}.toml`);
        await Bun.write(file, toml(p, spec.replace("_", " "), level, tier, faction));
        console.log(`${file}: ${Object.keys(p.items).length} slots`);
      }
    }
  }
}
