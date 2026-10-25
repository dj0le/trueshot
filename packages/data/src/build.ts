// Joins the raw client tables and the talentsforever export into generated/hunter.json.
// Run `bun run fetch` first. Problems found while joining are printed and fail the build,
// so a new client build that moves things around cannot slip through silently.
import { join } from "node:path";
import { csvToRows, type Row } from "./csv";
import type {
  Ability,
  HunterData,
  PetFamily,
  Spell,
  SpellCategory,
  SpellEffect,
  Talent,
  TalentRankEffect,
} from "./schema";
import { HUNTER_TRAIT_TREE_ID, TALENTSFOREVER_HUNTER_URL, WOWF_BUILD } from "./sources";

const rawDir = join(import.meta.dir, "..", "raw", WOWF_BUILD);
const outPath = join(import.meta.dir, "..", "generated", "hunter.json");

// Spells the server triggers by script, so the client tables do not link them. Each link is
// written onto the source effect's triggerSpell and checked against the source's tooltip.
const LINKS: { from: number; effectIndex: number; to: number; tooltip: string }[] = [
  // Volley's periodic dummy fires a separate damage spell every second.
  { from: 1510, effectIndex: 2, to: 1279721, tooltip: "causing 70 Arcane damage" },
  { from: 14294, effectIndex: 2, to: 1279719, tooltip: "causing 91 Arcane damage" },
  { from: 14295, effectIndex: 2, to: 1279715, tooltip: "causing 112 Arcane damage" },
];

// Spells scripts in the engine apply directly, with why.
const EXTRA_SPELLS: { id: number; why: string }[] = [
  { id: 1242512, why: "Rapid Recuperation's regen-while-casting buff, applied when Serpent Sting lands" },
];

// How far to follow EffectTriggerSpell chains from the spells we start with.
const TRIGGER_DEPTH = 3;
// Stale trait nodes from Classic sit far outside the 0..12000 grid the live talents use.
const GRID_LIMIT = 20000;

const problems: string[] = [];

// Tables =====================================================================

async function table(name: string): Promise<Row[]> {
  return csvToRows(await Bun.file(join(rawDir, `${name}.csv`)).text());
}

const num = (s: string | undefined) => {
  const n = Number(s ?? 0);
  // Floats come through as 0.07999999821; six places is far below anything the game resolves.
  return Number.isInteger(n) ? n : Math.round(n * 1e6) / 1e6;
};

// Index rows by a column, keeping only the base difficulty where the table has one.
function bySpell(rows: Row[], key = "SpellID"): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    if ((r.DifficultyID ?? "0") !== "0") continue;
    const k = r[key]!;
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.ID!, r]));

const [
  spellName,
  spellEffect,
  spellMisc,
  spellLevels,
  spellPower,
  spellCooldowns,
  spellCategories,
  spellCategory,
  spellCastTimes,
  spellDuration,
  spellRange,
  spellAuraOptions,
  spellProcsPerMinute,
  spellClassOptions,
  traitNode,
  traitNodeEntry,
  traitNodeXEntry,
  traitDefinition,
  traitDefinitionEffectPoints,
  traitEdge,
  curvePoint,
  creatureFamily,
  skillLineAbility,
] = await Promise.all(
  [
    "SpellName",
    "SpellEffect",
    "SpellMisc",
    "SpellLevels",
    "SpellPower",
    "SpellCooldowns",
    "SpellCategories",
    "SpellCategory",
    "SpellCastTimes",
    "SpellDuration",
    "SpellRange",
    "SpellAuraOptions",
    "SpellProcsPerMinute",
    "SpellClassOptions",
    "TraitNode",
    "TraitNodeEntry",
    "TraitNodeXTraitNodeEntry",
    "TraitDefinition",
    "TraitDefinitionEffectPoints",
    "TraitEdge",
    "CurvePoint",
    "CreatureFamily",
    "SkillLineAbility",
  ].map(table),
);

const names = new Map(spellName!.map((r) => [r.ID!, r.Name_lang!]));
const effects = bySpell(spellEffect!);
const misc = bySpell(spellMisc!);
const levels = bySpell(spellLevels!);
const power = bySpell(spellPower!);
const cooldowns = bySpell(spellCooldowns!);
const categories = bySpell(spellCategories!);
const auraOptions = bySpell(spellAuraOptions!);
const classOptions = bySpell(spellClassOptions!);
const castTimes = byId(spellCastTimes!);
const durations = byId(spellDuration!);
const ranges = byId(spellRange!);
const ppm = byId(spellProcsPerMinute!);
const categoryRows = byId(spellCategory!);

const tf = (await Bun.file(join(rawDir, "talentsforever-hunter.json")).json()) as TalentsForever;

type TalentsForever = {
  talents: {
    trees: {
      name: string;
      talents: {
        name: string;
        max: number;
        row: number;
        col: number;
        passive: boolean;
        desc: string[];
        classic?: { status?: string };
      }[];
    }[];
  };
  spellbook: { tabs: { name: string; spells: [string, string][] }[]; levels: Record<string, number[]> };
  spell_desc: Record<string, { id?: number; d?: string }>;
};

// Spells =====================================================================

function buildEffect(r: Row): SpellEffect {
  return {
    index: num(r.EffectIndex),
    effect: num(r.Effect),
    aura: num(r.EffectAura),
    basePoints: num(r.EffectBasePointsF),
    variance: num(r.Variance),
    pointsPerLevel: num(r.EffectRealPointsPerLevel),
    apCoefficient: num(r.BonusCoefficientFromAP),
    spCoefficient: num(r.EffectBonusCoefficient),
    periodMs: num(r.EffectAuraPeriod),
    triggerSpell: num(r.EffectTriggerSpell),
    chainTargets: num(r.EffectChainTargets),
    mechanic: num(r.EffectMechanic),
    miscValue: [num(r.EffectMiscValue_0), num(r.EffectMiscValue_1)],
    radiusIndex: [num(r.EffectRadiusIndex_0), num(r.EffectRadiusIndex_1)],
    implicitTarget: [num(r.ImplicitTarget_0), num(r.ImplicitTarget_1)],
    classMask: [
      num(r.EffectSpellClassMask_0),
      num(r.EffectSpellClassMask_1),
      num(r.EffectSpellClassMask_2),
      num(r.EffectSpellClassMask_3),
    ],
  };
}

function buildSpell(id: string): Spell {
  const m = misc.get(id)?.[0];
  const lv = levels.get(id)?.[0];
  const cd = cooldowns.get(id)?.[0];
  const cat = categories.get(id)?.[0];
  const ao = auraOptions.get(id)?.[0];
  const co = classOptions.get(id)?.[0];
  const range = ranges.get(m?.RangeIndex ?? "");
  const duration = durations.get(m?.DurationIndex ?? "");

  return {
    id: num(id),
    name: names.get(id)!,
    school: num(m?.SchoolMask),
    attributes: Array.from({ length: 17 }, (_, i) => num(m?.[`Attributes_${i}`])),
    // Instant shots use a -1000000 sentinel row; to the sim they are simply instant.
    castTimeMs: Math.max(0, num(castTimes.get(m?.CastingTimeIndex ?? "")?.Base)),
    durationMs: num(duration?.Duration),
    maxDurationMs: num(duration?.MaxDuration),
    rangeMin: num(range?.RangeMin_0),
    rangeMax: num(range?.RangeMax_0),
    speed: num(m?.Speed),
    baseLevel: num(lv?.BaseLevel),
    spellLevel: num(lv?.SpellLevel),
    maxLevel: num(lv?.MaxLevel),
    cooldownMs: num(cd?.RecoveryTime),
    categoryCooldownMs: num(cd?.CategoryRecoveryTime),
    gcdMs: num(cd?.StartRecoveryTime),
    category: num(cat?.Category),
    gcdCategory: num(cat?.StartRecoveryCategory),
    defenseType: num(cat?.DefenseType),
    preventionType: num(cat?.PreventionType),
    mechanic: num(cat?.Mechanic),
    dispelType: num(cat?.DispelType),
    power: (power.get(id) ?? [])
      .sort((a, b) => num(a.OrderIndex) - num(b.OrderIndex))
      .map((p) => ({
        type: num(p.PowerType),
        cost: num(p.ManaCost),
        costPct: num(p.PowerCostPct),
        costPerLevel: num(p.ManaCostPerLevel),
      })),
    proc: ao
      ? {
          chance: num(ao.ProcChance),
          charges: num(ao.ProcCharges),
          ppm: num(ppm.get(ao.SpellProcsPerMinuteID ?? "")?.BaseProcRate),
          categoryRecoveryMs: num(ao.ProcCategoryRecovery),
          typeMask: [num(ao.ProcTypeMask_0), num(ao.ProcTypeMask_1)],
          cumulative: num(ao.CumulativeAura),
        }
      : null,
    classOptions: co
      ? {
          set: num(co.SpellClassSet),
          mask: [
            num(co.SpellClassMask_0),
            num(co.SpellClassMask_1),
            num(co.SpellClassMask_2),
            num(co.SpellClassMask_3),
          ],
        }
      : null,
    effects: (effects.get(id) ?? []).map(buildEffect).sort((a, b) => a.index - b.index),
  };
}

// Abilities ==================================================================

const rankNumber = (rank: string) => (rank ? Number(rank.replace("Rank ", "")) : null);

const abilities: Ability[] = [];
for (const tab of tf.spellbook.tabs) {
  const byName = new Map<string, Ability>();
  for (const [name, rank] of tab.spells) {
    const id = tf.spell_desc[`Hunter|${name}|${rank}`]?.id;
    if (!id) {
      problems.push(`no spell id for ${name} ${rank}`);
      continue;
    }
    if (!names.has(String(id))) problems.push(`${name} ${rank}: spell ${id} not in SpellName`);
    const r = rankNumber(rank);
    const level = tf.spellbook.levels[name]?.[(r ?? 1) - 1] ?? num(levels.get(String(id))?.[0]?.BaseLevel);
    const ability = byName.get(name) ?? { name, tab: tab.name, ranks: [] };
    ability.ranks.push({ rank: r, spellId: id, level });
    byName.set(name, ability);
  }
  for (const a of byName.values()) {
    a.ranks.sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0));
    abilities.push(a);
  }
}

// Talents ====================================================================

const entriesByNode = new Map<string, string[]>();
for (const r of traitNodeXEntry!) {
  entriesByNode.set(r.TraitNodeID!, [...(entriesByNode.get(r.TraitNodeID!) ?? []), r.TraitNodeEntryID!]);
}
const nodeEntries = byId(traitNodeEntry!);
const definitions = byId(traitDefinition!);

const curves = new Map<string, Row[]>();
for (const r of curvePoint!) curves.set(r.CurveID!, [...(curves.get(r.CurveID!) ?? []), r]);
const effectPoints = new Map<string, Row[]>();
for (const r of traitDefinitionEffectPoints!) {
  effectPoints.set(r.TraitDefinitionID!, [...(effectPoints.get(r.TraitDefinitionID!) ?? []), r]);
}

const tfTalents = new Map(
  tf.talents.trees.flatMap((tree) => tree.talents.map((t) => [t.name, { ...t, tree: tree.name }] as const)),
);

const talents: Talent[] = [];
const talentByNode = new Map<string, Talent>();
for (const node of traitNode!) {
  if (node.TraitTreeID !== HUNTER_TRAIT_TREE_ID) continue;
  if (num(node.PosX) > GRID_LIMIT || num(node.PosY) > GRID_LIMIT) continue;
  for (const entryId of entriesByNode.get(node.ID!) ?? []) {
    const entry = nodeEntries.get(entryId)!;
    const def = definitions.get(entry.TraitDefinitionID!)!;
    const name = def.OverrideName_lang || names.get(def.SpellID!) || `spell ${def.SpellID}`;
    const known = tfTalents.get(name);
    if (!known) {
      problems.push(`talent ${name} (node ${node.ID}) is not in the talentsforever trees`);
      continue;
    }
    const maxRank = num(entry.MaxRanks);
    if (maxRank !== known.max) problems.push(`talent ${name}: client has ${maxRank} ranks, talentsforever ${known.max}`);

    const rankEffects: TalentRankEffect[] = (effectPoints.get(def.ID!) ?? [])
      .map((p) => ({
        effectIndex: num(p.EffectIndex),
        operation: num(p.OperationType),
        values: (curves.get(p.CurveID!) ?? [])
          .sort((a, b) => num(a.Pos_0) - num(b.Pos_0))
          .map((c) => num(c.Pos_1)),
      }))
      .sort((a, b) => a.effectIndex - b.effectIndex);
    for (const e of rankEffects) {
      if (e.values.length !== maxRank) problems.push(`talent ${name}: effect ${e.effectIndex} has ${e.values.length} rank values for ${maxRank} ranks`);
    }

    const talent: Talent = {
      name,
      tree: known.tree,
      row: known.row,
      col: known.col,
      maxRank,
      passive: known.passive,
      spellId: num(def.SpellID),
      rankEffects,
      requires: [],
      text: known.desc,
      classicStatus: known.classic?.status ?? null,
    };
    talents.push(talent);
    talentByNode.set(node.ID!, talent);
  }
}
for (const name of tfTalents.keys()) {
  if (!talents.some((t) => t.name === name)) problems.push(`talentsforever talent ${name} has no client trait node`);
}
for (const edge of traitEdge!) {
  const from = talentByNode.get(edge.LeftTraitNodeID!);
  const to = talentByNode.get(edge.RightTraitNodeID!);
  // Edges are drawn lines, not arrows: the prerequisite is the end in the higher row.
  if (!from || !to || from.tree !== to.tree || from.row === to.row) continue;
  const [pre, post] = from.row < to.row ? [from, to] : [to, from];
  if (!post.requires.includes(pre.name)) post.requires.push(pre.name);
}
talents.sort((a, b) => a.tree.localeCompare(b.tree) || a.row - b.row || a.col - b.col);

// Spell closure ==============================================================

const wanted = new Set<string>([
  ...abilities.flatMap((a) => a.ranks.map((r) => String(r.spellId))),
  ...talents.map((t) => String(t.spellId)),
  ...LINKS.map((l) => String(l.to)),
  ...EXTRA_SPELLS.map((e) => String(e.id)),
]);
let frontier = [...wanted];
for (let depth = 0; depth < TRIGGER_DEPTH && frontier.length > 0; depth++) {
  const next: string[] = [];
  for (const id of frontier) {
    for (const e of effects.get(id) ?? []) {
      const t = e.EffectTriggerSpell!;
      if (t !== "0" && names.has(t) && !wanted.has(t)) {
        wanted.add(t);
        next.push(t);
      }
    }
  }
  frontier = next;
}

const spells: Record<string, Spell> = {};
for (const id of [...wanted].sort((a, b) => num(a) - num(b))) {
  if (names.has(id)) spells[id] = buildSpell(id);
}

for (const link of LINKS) {
  const effect = spells[String(link.from)]?.effects.find((e) => e.index === link.effectIndex);
  if (!effect || !spells[String(link.to)]) {
    problems.push(`link ${link.from} -> ${link.to}: spell or effect missing`);
    continue;
  }
  const text = Object.values(tf.spell_desc).find((d) => d.id === link.from)?.d ?? "";
  if (!text.includes(link.tooltip)) problems.push(`link ${link.from} -> ${link.to}: tooltip no longer says "${link.tooltip}"`);
  effect.triggerSpell = link.to;
}

const usedCategories: Record<string, SpellCategory> = {};
for (const s of Object.values(spells)) {
  for (const c of [s.category, s.gcdCategory]) {
    const row = categoryRows.get(String(c));
    if (c && row) {
      usedCategories[String(c)] = {
        id: c,
        name: row.Name_lang ?? "",
        flags: num(row.Flags),
        maxCharges: num(row.MaxCharges),
        chargeRecoveryMs: num(row.ChargeRecoveryTime),
      };
    }
  }
}

// Pets =======================================================================

const PET_PASSIVE = "Tamed Pet Passive (DND)";
const spellsBySkillLine = new Map<string, string[]>();
for (const r of skillLineAbility!) {
  spellsBySkillLine.set(r.SkillLine!, [...(spellsBySkillLine.get(r.SkillLine!) ?? []), r.Spell!]);
}
const petAbilityNames = new Set(abilities.filter((a) => a.tab === "Pets").map((a) => a.name));
const effectValue = (id: string, aura: number) =>
  num((effects.get(id) ?? []).find((e) => num(e.EffectAura) === aura)?.EffectBasePointsF);

// The family passive is the one that carries a physical damage-done aura (79, school 1).
const isFamilyPassive = (id: string) =>
  names.get(id) === PET_PASSIVE &&
  (effects.get(id) ?? []).some((e) => num(e.EffectAura) === 79 && num(e.EffectMiscValue_0) === 1);

let petPassives: string[] | null = null;
const petFamilies: PetFamily[] = [];
for (const r of creatureFamily!.filter((r) => num(r.PetFoodMask) !== 0)) {
  const skillLines = [num(r.SkillLine_0), num(r.SkillLine_1)].filter((s) => s !== 0);
  const familySpells = skillLines.flatMap((sl) => spellsBySkillLine.get(String(sl)) ?? []);
  const passives = familySpells.filter((id) => names.get(id) === PET_PASSIVE);
  const own = passives.filter(isFamilyPassive);
  if (own.length !== 1) {
    problems.push(`pet family ${r.Name_lang}: expected one family passive, found ${own.length}`);
    continue;
  }
  const shared = passives.filter((id) => !isFamilyPassive(id)).sort();
  if (petPassives && petPassives.join() !== shared.join()) problems.push(`pet family ${r.Name_lang}: shared passives differ`);
  petPassives ??= shared;
  for (const id of [...shared, own[0]!]) wanted.add(id);

  petFamilies.push({
    id: num(r.ID),
    name: r.Name_lang!,
    petFoodMask: num(r.PetFoodMask),
    petTalentType: num(r.PetTalentType),
    skillLines,
    passiveSpellId: num(own[0]),
    damagePct: effectValue(own[0]!, 79),
    armorPct: effectValue(own[0]!, 142),
    healthPct: effectValue(own[0]!, 133),
    abilities: [...new Set(familySpells.map((id) => names.get(id)!).filter((n) => petAbilityNames.has(n)))].sort(),
  });
}
// Shared passives may trigger further spells (Frenzy's haste buff).
for (const id of petPassives ?? []) {
  for (const e of effects.get(id) ?? []) if (e.EffectTriggerSpell !== "0") wanted.add(e.EffectTriggerSpell!);
}
for (const id of wanted) if (names.has(id) && !spells[id]) spells[id] = buildSpell(id);

// Output =====================================================================

const data: HunterData = {
  build: WOWF_BUILD,
  sources: [
    { name: "WoW Forever client tables via wago.tools", url: `https://wago.tools/db2?build=${WOWF_BUILD}` },
    { name: "talentsforever.com", url: TALENTSFOREVER_HUNTER_URL, license: "CC BY 4.0" },
  ],
  spells,
  categories: usedCategories,
  abilities,
  talents,
  petFamilies,
  petPassives: (petPassives ?? []).map(num),
};

await Bun.write(outPath, JSON.stringify(data, null, 1) + "\n");
console.log(
  `${Object.keys(spells).length} spells, ${abilities.length} abilities, ${talents.length} talents, ` +
    `${petFamilies.length} pet families -> ${outPath}`,
);
if (problems.length > 0) {
  console.error(`\n${problems.length} problems:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
