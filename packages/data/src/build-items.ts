// Builds generated/items.json: every item a level 40+ hunter could wear, with stats computed the
// way the Forever client stores them. Cross-checks the formulas against Classic Era's explicit
// values for items both clients share, and fails if they drift.
import type { Row } from "./csv";
import { ITEMS_PATH } from "./index";
import type { Item, ItemStats } from "./schema";
import { ERA_DIR, byId, bySpell, groupBy, num, tables } from "./tables";

const db = await tables([
  "ItemSparse",
  "Item",
  "ItemEffect",
  "ItemXItemEffect",
  "RandPropPoints",
  "ItemDamageRanged",
  "ItemDamageThrown",
  "ItemDamageOneHand",
  "ItemDamageTwoHand",
  "SpellEffect",
  "SpellName",
]);
const era = await tables(["ItemSparse", "ItemEffect"], ERA_DIR);

const items = byId(db.Item);
const rpp = byId(db.RandPropPoints);
const names = new Map(db.SpellName.map((r) => [r.ID!, r.Name_lang!]));
const effectsBySpell = bySpell(db.SpellEffect);

const addStat = (stats: ItemStats, key: keyof ItemStats, v: number) => (stats[key] = (stats[key] ?? 0) + v);
const weaponSpeed = (r: Row) => num(r.ItemDelay) / 1000;

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

// Adds one ItemModType amount; false when it is not a stat we read. Generic attack power counts
// for ranged attacks too.
function addModStat(stats: ItemStats, type: number, amount: number): boolean {
  const key = STAT[type];
  if (!key) return false;
  addStat(stats, key, amount);
  if (key === "attackPower") addStat(stats, "rangedAttackPower", amount);
  return true;
}

// Armor a hunter can wear and weapons a hunter can use, as Item ClassID / SubclassID.
const ARMOR_OK = new Set([0, 1, 2, 3]); // misc, cloth, leather, mail
const WEAPON_OK = new Set([0, 1, 2, 3, 6, 7, 8, 10, 13, 15, 16, 18]);

// Weapon inventory types: what kind of weapon each is, and the table holding its DPS by item level.
const ranged = byId(db.ItemDamageRanged);
const oneHand = byId(db.ItemDamageOneHand);
type WeaponKind = NonNullable<Item["weapon"]>["kind"];
const WEAPON: Record<number, { kind: WeaponKind; damage: Map<string, Row> }> = {
  15: { kind: "ranged", damage: ranged },
  26: { kind: "ranged", damage: ranged },
  25: { kind: "thrown", damage: byId(db.ItemDamageThrown) },
  17: { kind: "twoHand", damage: byId(db.ItemDamageTwoHand) },
  13: { kind: "oneHand", damage: oneHand },
  21: { kind: "oneHand", damage: oneHand },
  22: { kind: "oneHand", damage: oneHand },
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
    if (!addModStat(stats, type, amount)) unparsed.push(type);
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
    const add = (k: keyof ItemStats, v: number) => addStat(stats, k, v);
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

// Forever joins items to effects through ItemXItemEffect; Classic Era keeps ParentItemID on the effect.
const effectById = byId(db.ItemEffect);
const foreverEffects = groupBy(
  db.ItemXItemEffect.flatMap((x): Row[] => {
    const e = effectById.get(x.ItemEffectID!);
    return e ? [{ ...e, ParentItemID: x.ItemID! }] : [];
  }),
  (r) => r.ParentItemID!,
);
const classicEffects = groupBy(era.ItemEffect, (r) => r.ParentItemID!);

// Classic Era stores amounts and weapon damage outright.
function explicitStats(r: Row): { stats: ItemStats; unparsed: number[] } {
  const stats: ItemStats = {};
  const unparsed: number[] = [];
  for (let i = 0; i < 10; i++) {
    const type = num(r[`StatModifier_bonusStat_${i}`]);
    const amount = num(r[`StatModifier_bonusAmount_${i}`]);
    if (type <= 0 || amount === 0) continue;
    if (!addModStat(stats, type, amount)) unparsed.push(type);
  }
  return { stats, unparsed };
}

function buildItem(r: Row, source: "forever" | "classic"): Item | null {
  const base = items.get(r.ID!);
  if (!base) return null;
  // Developer placeholders shipped in the client ("Test Dagger", "... test copy").
  if (/\btest\b/i.test(r.Display_lang ?? "")) return null;
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
  const w = WEAPON[inv];
  if (classId === 2 && w) {
    const { kind } = w;
    const speed = weaponSpeed(r);
    if (source === "classic") {
      weapon = { kind, min: num(r.MinDamage_0), max: num(r.MaxDamage_0), speed };
    } else {
      const dps = num(w.damage.get(r.ItemLevel!)?.[`Quality_${num(r.OverallQualityID)}`]);
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
const shipped = new Set(db.ItemSparse.map((r) => r.ID!));
for (const r of db.ItemSparse) {
  const item = buildItem(r, "forever");
  if (item) out.push(item);
}
// Items Forever has (they are in its Item table) whose details only the server sends.
// Classic Era's client also carries Season of Discovery items (ids 200000-249999). Forever's Item
// table lists them too, but Forever's own new items start at 250000 and ship in its client, so these
// are not Forever gear.
const SOD_IDS = { from: 200000, to: 250000 };
for (const r of era.ItemSparse) {
  if (shipped.has(r.ID!) || !items.has(r.ID!)) continue;
  if (num(r.ID) >= SOD_IDS.from && num(r.ID) < SOD_IDS.to) continue;
  const item = buildItem(r, "classic");
  if (item) out.push(item);
}
out.sort((a, b) => a.id - b.id);

// Cross-check against Classic Era's explicit numbers for items both clients have.
const eraById = byId(era.ItemSparse);
let statChecks = 0;
let statMismatches = 0;
let weaponChecks = 0;
let weaponMismatches = 0;
let retunedSpeeds = 0;
const PRIMARY: (keyof ItemStats)[] = ["agility", "strength", "intellect", "spirit", "stamina"];
for (const item of out) {
  if (item.source !== "forever") continue;
  const e = eraById.get(String(item.id));
  if (!e) continue;
  const eraStats = explicitStats(e).stats;
  for (const key of PRIMARY) {
    if (eraStats[key] === undefined && item.stats[key] === undefined) continue;
    statChecks++;
    if (eraStats[key] !== item.stats[key]) statMismatches++;
  }
  // Forever retunes many weapon speeds while keeping their DPS, so DPS is what must match.
  if (item.weapon && num(e.MaxDamage_0) > 0 && item.itemLevel === num(e.ItemLevel)) {
    weaponChecks++;
    const dps = (w: { min: number; max: number; speed: number }) => (w.min + w.max) / 2 / w.speed;
    const eraWeapon = { min: num(e.MinDamage_0), max: num(e.MaxDamage_0), speed: weaponSpeed(e) };
    if (Math.abs(dps(item.weapon) / dps(eraWeapon) - 1) > 0.02) weaponMismatches++;
    if (item.weapon.speed !== eraWeapon.speed) retunedSpeeds++;
  }
}

await Bun.write(ITEMS_PATH, JSON.stringify(out) + "\n");
console.log(`${out.length} items -> ${ITEMS_PATH}`);
const pct = (a: number, b: number) => ((100 * a) / Math.max(1, b)).toFixed(1);
console.log(`vs Classic Era: stats differ on ${statMismatches}/${statChecks} (${pct(statMismatches, statChecks)}%), weapon DPS differs by more than 2% on ${weaponMismatches}/${weaponChecks} (${pct(weaponMismatches, weaponChecks)}%), ${retunedSpeeds} weapons have a new speed`);
// Forever retunes some items, so a few differences are real. A lot means a broken formula.
if (statMismatches / Math.max(1, statChecks) > 0.1 || weaponMismatches / Math.max(1, weaponChecks) > 0.1) {
  console.error("too many differences from Classic Era; check the item formulas");
  process.exit(1);
}
