// Builds generated/items.json: every item a level 40+ hunter could wear, with stats computed the
// way the Forever client stores them. Cross-checks the formulas against Classic Era's explicit
// values for items both clients share, and fails if they drift.
import { join } from "node:path";
import { csvToRows, type Row } from "./csv";
import type { Item, ItemStats } from "./schema";
import { CLASSIC_ERA_BUILD, WOWF_BUILD } from "./sources";

const rawDir = join(import.meta.dir, "..", "raw", WOWF_BUILD);
const eraDir = join(import.meta.dir, "..", "raw", `classic-era-${CLASSIC_ERA_BUILD}`);
const outPath = join(import.meta.dir, "..", "generated", "items.json");

const table = async (dir: string, name: string) => csvToRows(await Bun.file(join(dir, `${name}.csv`)).text());
const num = (s: string | undefined) => Number(s ?? 0);
const byId = (rows: Row[]) => new Map(rows.map((r) => [r.ID!, r]));

const [sparse, itemRows, itemEffect, randProp, dmgRanged, dmgThrown, dmgOne, dmgTwo, spellEffect, spellName, eraSparse, eraEffect] =
  await Promise.all([
    table(rawDir, "ItemSparse"),
    table(rawDir, "Item"),
    table(rawDir, "ItemEffect"),
    table(rawDir, "RandPropPoints"),
    table(rawDir, "ItemDamageRanged"),
    table(rawDir, "ItemDamageThrown"),
    table(rawDir, "ItemDamageOneHand"),
    table(rawDir, "ItemDamageTwoHand"),
    table(rawDir, "SpellEffect"),
    table(rawDir, "SpellName"),
    table(eraDir, "ItemSparse"),
    table(eraDir, "ItemEffect"),
  ]);

const items = byId(itemRows);
const rpp = byId(randProp);
const names = new Map(spellName.map((r) => [r.ID!, r.Name_lang!]));
const effectsBySpell = new Map<string, Row[]>();
for (const r of spellEffect) {
  if (r.DifficultyID !== "0") continue;
  effectsBySpell.set(r.SpellID!, [...(effectsBySpell.get(r.SpellID!) ?? []), r]);
}

// Which RandPropPoints column an inventory type reads.
const SLOT_GROUP: Record<number, number> = {
  1: 0, 5: 0, 7: 0, 17: 0, 20: 0, // head, chest, legs, two-hand, robe
  3: 1, 6: 1, 8: 1, 10: 1, 12: 1, // shoulder, waist, feet, hands, trinket
  2: 2, 9: 2, 11: 2, 14: 2, 16: 2, 23: 2, // neck, wrist, finger, shield, back, held in off-hand
  13: 3, 21: 3, 22: 3, // one-hand, main hand, off hand
  15: 4, 25: 4, 26: 4, 28: 4, // ranged, thrown, ranged right, relic
};
const QUALITY_COLUMN: Record<number, string> = { 2: "Good", 3: "Superior", 4: "Epic", 5: "Epic" };

// ItemModType -> our stat name.
const STAT: Record<number, keyof ItemStats> = {
  3: "agility",
  4: "strength",
  5: "intellect",
  6: "spirit",
  7: "stamina",
  16: "hitRating",
  17: "hitRating",
  31: "hitRating",
  19: "critRating",
  20: "critRating",
  32: "critRating",
  38: "attackPower",
  39: "rangedAttackPower",
  41: "healing",
  42: "spellDamage",
  43: "mp5",
  45: "spellDamage",
};

// Armor a hunter can wear and weapons a hunter can use, as Item ClassID / SubclassID.
const ARMOR_OK = new Set([0, 1, 2, 3]); // misc, cloth, leather, mail
const WEAPON_OK = new Set([0, 1, 2, 3, 6, 7, 8, 10, 13, 15, 16, 18]);

const DAMAGE_TABLE: Record<number, Map<string, Row>> = {
  15: byId(dmgRanged),
  26: byId(dmgRanged),
  25: byId(dmgThrown),
  17: byId(dmgTwo),
  13: byId(dmgOne),
  21: byId(dmgOne),
  22: byId(dmgOne),
};
const WEAPON_KIND: Record<number, "ranged" | "thrown" | "oneHand" | "twoHand"> = {
  15: "ranged",
  26: "ranged",
  25: "thrown",
  17: "twoHand",
  13: "oneHand",
  21: "oneHand",
  22: "oneHand",
};

function allocatedStats(r: Row): { stats: ItemStats; unparsed: number[] } {
  const stats: ItemStats = {};
  const unparsed: number[] = [];
  const group = SLOT_GROUP[num(r.InventoryType)];
  const quality = QUALITY_COLUMN[num(r.OverallQualityID)];
  const points = rpp.get(r.ItemLevel!);
  for (let i = 0; i < 10; i++) {
    const type = num(r[`StatModifier_bonusStat_${i}`]);
    const alloc = num(r[`StatPercentEditor_${i}`]);
    if (type <= 0 || alloc === 0) continue;
    if (group === undefined || !quality || !points) {
      unparsed.push(type);
      continue;
    }
    const amount = Math.round((alloc * num(points[`${quality}_${group}`])) / 10000);
    const key = STAT[type];
    if (key) stats[key] = (stats[key] ?? 0) + amount;
    else unparsed.push(type);
  }
  return { stats, unparsed };
}

// Simple equip spells become plain stats; anything else is listed on the item.
function equipStats(spellId: string, stats: ItemStats): boolean {
  const effects = effectsBySpell.get(spellId) ?? [];
  if (effects.length === 0) return false;
  let all = true;
  for (const e of effects) {
    const bp = num(e.EffectBasePointsF);
    const aura = num(e.EffectAura);
    const add = (k: keyof ItemStats, v: number) => (stats[k] = (stats[k] ?? 0) + v);
    if (aura === 99) add("attackPower", bp);
    else if (aura === 124) add("rangedAttackPower", bp);
    else if (aura === 52 || aura === 290) add("critPct", bp);
    else if (aura === 54) add("hitPct", bp);
    else if (aura === 85 && num(e.EffectMiscValue_0) === 0) add("mp5", bp);
    else if (aura === 13) add("spellDamage", bp);
    else if (aura === 135) add("healing", bp);
    else if (aura === 22) continue; // resistances
    else if (aura === 55 || aura === 593 || aura === 319) continue; // spell hit, expertise, melee haste: not ranged
    else all = false;
  }
  return all;
}

const effectsByItem = (rows: Row[]) => {
  const m = new Map<string, Row[]>();
  for (const r of rows) m.set(r.ParentItemID!, [...(m.get(r.ParentItemID!) ?? []), r]);
  return m;
};
const foreverEffects = effectsByItem(itemEffect);
const classicEffects = effectsByItem(eraEffect);

// Classic Era stores amounts and weapon damage outright.
function explicitStats(r: Row): { stats: ItemStats; unparsed: number[] } {
  const stats: ItemStats = {};
  const unparsed: number[] = [];
  for (let i = 0; i < 10; i++) {
    const type = num(r[`StatModifier_bonusStat_${i}`]);
    const amount = num(r[`StatModifier_bonusAmount_${i}`]);
    if (type <= 0 || amount === 0) continue;
    const key = STAT[type];
    if (key) stats[key] = (stats[key] ?? 0) + amount;
    else unparsed.push(type);
  }
  return { stats, unparsed };
}

function buildItem(r: Row, source: "forever" | "classic"): Item | null {
  const base = items.get(r.ID!);
  if (!base) return null;
  const classId = num(base.ClassID);
  const subclass = num(base.SubclassID);
  const inv = num(r.InventoryType);
  if (inv === 0 || num(r.OverallQualityID) < 2) return null;
  if (num(r.RequiredLevel) < 40 && num(r.ItemLevel) < 50) return null;
  if (classId === 4 && !ARMOR_OK.has(subclass)) return null;
  if (classId === 2 && !WEAPON_OK.has(subclass)) return null;
  if (classId !== 2 && classId !== 4) return null;

  const { stats, unparsed } = source === "forever" ? allocatedStats(r) : explicitStats(r);
  const equipSpells: number[] = [];
  const procSpells: number[] = [];
  const unparsedEquip: string[] = [];
  for (const e of (source === "forever" ? foreverEffects : classicEffects).get(r.ID!) ?? []) {
    const spell = e.SpellID!;
    if (e.TriggerType === "1") {
      equipSpells.push(num(spell));
      if (!equipStats(spell, stats)) unparsedEquip.push(names.get(spell) ?? spell);
    } else if (e.TriggerType === "2") {
      procSpells.push(num(spell));
    }
  }

  let weapon: Item["weapon"];
  const kind = WEAPON_KIND[inv];
  if (classId === 2 && kind) {
    const speed = num(r.ItemDelay) / 1000;
    if (source === "classic") {
      weapon = { kind, min: num(r.MinDamage_0), max: num(r.MaxDamage_0), speed };
    } else {
      const dps = num(DAMAGE_TABLE[inv]!.get(r.ItemLevel!)?.[`Quality_${num(r.OverallQualityID)}`]);
      const avg = dps * speed;
      const variance = num(r.DmgVariance);
      weapon = { kind, min: Math.floor(avg * (1 - variance / 2)), max: Math.round(avg * (1 + variance / 2)), speed };
    }
  }

  return {
    id: num(r.ID),
    name: r.Display_lang!,
    source,
    quality: num(r.OverallQualityID),
    itemLevel: num(r.ItemLevel),
    requiredLevel: num(r.RequiredLevel),
    inventoryType: inv,
    classId,
    subclassId: subclass,
    stats,
    ...(weapon ? { weapon } : {}),
    equipSpells,
    procSpells,
    unparsedStats: unparsed,
    unparsedEquip,
  };
}

const out: Item[] = [];
const shipped = new Set(sparse.map((r) => r.ID!));
for (const r of sparse) {
  const item = buildItem(r, "forever");
  if (item) out.push(item);
}
// Items Forever has (they are in its Item table) whose details only the server sends.
for (const r of eraSparse) {
  if (shipped.has(r.ID!) || !items.has(r.ID!)) continue;
  const item = buildItem(r, "classic");
  if (item) out.push(item);
}
out.sort((a, b) => a.id - b.id);

// Cross-check against Classic Era's explicit numbers for items both clients have.
const era = byId(eraSparse);
let statChecks = 0;
let statMismatches = 0;
let weaponChecks = 0;
let weaponMismatches = 0;
let retunedSpeeds = 0;
const ERA_STAT: Record<number, keyof ItemStats> = { 3: "agility", 4: "strength", 5: "intellect", 6: "spirit", 7: "stamina" };
for (const item of out) {
  if (item.source !== "forever") continue;
  const e = era.get(String(item.id));
  if (!e) continue;
  const eraStats: ItemStats = {};
  for (let i = 0; i < 10; i++) {
    const key = ERA_STAT[num(e[`StatModifier_bonusStat_${i}`])];
    if (key) eraStats[key] = (eraStats[key] ?? 0) + num(e[`StatModifier_bonusAmount_${i}`]);
  }
  for (const key of Object.values(ERA_STAT)) {
    if (eraStats[key] === undefined && item.stats[key] === undefined) continue;
    statChecks++;
    if (eraStats[key] !== item.stats[key]) statMismatches++;
  }
  // Forever retunes many weapon speeds while keeping their DPS, so DPS is what must match.
  if (item.weapon && num(e.MaxDamage_0) > 0 && item.itemLevel === num(e.ItemLevel)) {
    weaponChecks++;
    const dps = (w: { min: number; max: number; speed: number }) => (w.min + w.max) / 2 / w.speed;
    const eraWeapon = { min: num(e.MinDamage_0), max: num(e.MaxDamage_0), speed: num(e.ItemDelay) / 1000 };
    if (Math.abs(dps(item.weapon) / dps(eraWeapon) - 1) > 0.02) weaponMismatches++;
    if (item.weapon.speed !== eraWeapon.speed) retunedSpeeds++;
  }
}

await Bun.write(outPath, JSON.stringify(out) + "\n");
console.log(`${out.length} items -> ${outPath}`);
const pct = (a: number, b: number) => ((100 * a) / Math.max(1, b)).toFixed(1);
console.log(`vs Classic Era: stats differ on ${statMismatches}/${statChecks} (${pct(statMismatches, statChecks)}%), weapon DPS differs by more than 2% on ${weaponMismatches}/${weaponChecks} (${pct(weaponMismatches, weaponChecks)}%), ${retunedSpeeds} weapons have a new speed`);
// Forever retunes some items, so a few differences are real. A lot means a broken formula.
if (statMismatches / Math.max(1, statChecks) > 0.1 || weaponMismatches / Math.max(1, weaponChecks) > 0.1) {
  console.error("too many differences from Classic Era; check the item formulas");
  process.exit(1);
}
