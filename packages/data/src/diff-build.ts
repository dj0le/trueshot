// What changed for hunters between two Forever client builds (PLAN.md task 59):
//
//   bun run diff-build <old build> <new build>
//
// Fetches any build not yet in packages/data/raw/, then lists hunter spell rows that changed, were
// added or were removed (spells of class set 9, the hunter talent tree's spells, talentsforever's
// hunter and pet spells, and what they trigger),
// hunter talent changes (nodes, max ranks, and the curve points that hold rank values), and which
// overrides the new build would make stale. Run it when wago.tools shows a new wowf build, before
// bumping WOWF_BUILD.
import { exists, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Row } from "./csv";
import { loadOverrides } from "./overrides";
import { DB2_TABLES, HUNTER_TRAIT_TREE_ID, db2Url } from "./sources";
import { byId, groupBy, tables } from "./tables";

const RAW = join(import.meta.dir, "..", "raw");

async function fetchBuild(build: string): Promise<string> {
  const dir = join(RAW, build);
  await mkdir(dir, { recursive: true });
  for (const table of DB2_TABLES) {
    const path = join(dir, `${table}.csv`);
    if (await exists(path)) continue;
    const res = await fetch(db2Url(table, build), { headers: { "User-Agent": "trueshot data fetcher" } });
    if (!res.ok) throw new Error(`${table} for ${build}: HTTP ${res.status}`);
    await Bun.write(path, await res.arrayBuffer());
    console.error(`fetched ${build}/${table}.csv`);
  }
  return dir;
}

const SPELL_TABLES = ["SpellEffect", "SpellMisc", "SpellCooldowns", "SpellPower", "SpellLevels", "SpellCategories", "SpellAuraOptions", "SpellCastTimes", "Spell", "SpellClassOptions"] as const;
const TRAIT_TABLES = ["TraitNode", "TraitNodeEntry", "TraitNodeXTraitNodeEntry", "TraitDefinition", "TraitDefinitionEffectPoints", "Curve", "CurvePoint"] as const;
const NAMES = ["SpellName"] as const;

type Build = Record<(typeof SPELL_TABLES)[number] | (typeof TRAIT_TABLES)[number] | (typeof NAMES)[number], Row[]>;

const load = async (dir: string) => (await tables([...SPELL_TABLES, ...TRAIT_TABLES, ...NAMES], dir)) as Build;
const spellOf = (r: Row) => r.SpellID ?? r.ID!;
const shown = (r: Row) => Object.entries(r).filter(([, v]) => v !== "" && v !== "0" && v !== "0.0").map(([k, v]) => `${k}=${v}`).join(", ");

// The hunter tree's talents: each node entry's spell, max ranks, position and rank curves.
function talents(b: Build): Map<string, { spell: string; ranks: string; pos: string; curves: string }> {
  const nodes = byId(b.TraitNode);
  const entries = byId(b.TraitNodeEntry);
  const defs = byId(b.TraitDefinition);
  const points = groupBy(b.TraitDefinitionEffectPoints, (r) => r.TraitDefinitionID!);
  const curve = groupBy(b.CurvePoint, (r) => r.CurveID!);
  const out = new Map<string, { spell: string; ranks: string; pos: string; curves: string }>();
  for (const x of b.TraitNodeXTraitNodeEntry) {
    const node = nodes.get(x.TraitNodeID!);
    const entry = entries.get(x.TraitNodeEntryID!);
    if (node?.TraitTreeID !== HUNTER_TRAIT_TREE_ID || !entry) continue;
    const spell = defs.get(entry.TraitDefinitionID!)?.SpellID ?? "?";
    const curves = (points.get(entry.TraitDefinitionID!) ?? [])
      .map((p) => `effect ${p.EffectIndex}: ${(curve.get(p.CurveID!) ?? []).map((c) => `${c.Pos_0}->${c.Pos_1}`).join(" ")}`)
      .join("; ");
    out.set(x.TraitNodeEntryID!, { spell, ranks: entry.MaxRanks!, pos: `${node.PosX},${node.PosY}`, curves });
  }
  return out;
}

const [oldBuild, newBuild] = process.argv.slice(2);
if (!oldBuild || !newBuild) {
  console.error("usage: bun run diff-build <old build> <new build>   e.g. 1.60.1.70753 1.60.1.70862");
  process.exit(1);
}
const [a, b] = await Promise.all([fetchBuild(oldBuild).then(load), fetchBuild(newBuild).then(load)]);
const name = new Map([...a.SpellName, ...b.SpellName].map((r) => [r.ID!, r.Name_lang!]));
const label = (spell: string) => `${name.get(spell) ?? "?"} (${spell})`;

const ta = talents(a);
const tb = talents(b);
const hunter = new Set<string>();
for (const t of [...ta.values(), ...tb.values()]) hunter.add(t.spell);
for (const r of [...a.SpellClassOptions, ...b.SpellClassOptions]) if (r.SpellClassSet === "9") hunter.add(r.SpellID!);
// talentsforever's hunter export names pet talents and spells too, which class set 9 misses.
for (const build of [newBuild, oldBuild]) {
  const file = Bun.file(join(RAW, build, "talentsforever-hunter.json"));
  if (!(await file.exists())) continue;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (/^(spell_?id|id)$/i.test(k) && typeof x === "number") hunter.add(String(x));
        walk(x);
      }
    }
  };
  walk(await file.json());
  break;
}
// Spells the hunter's spells trigger (procs, talent effects), one level down.
for (const r of [...a.SpellEffect, ...b.SpellEffect]) if (hunter.has(r.SpellID!) && r.EffectTriggerSpell && r.EffectTriggerSpell !== "0") hunter.add(r.EffectTriggerSpell);

console.log(`\nHunter changes from ${oldBuild} to ${newBuild}\n`);
let changes = 0;
for (const t of SPELL_TABLES) {
  const ra = byId(a[t]);
  const rb = byId(b[t]);
  for (const id of new Set([...ra.keys(), ...rb.keys()])) {
    const x = ra.get(id);
    const y = rb.get(id);
    const spell = spellOf((y ?? x)!);
    if (!hunter.has(spell) || JSON.stringify(x) === JSON.stringify(y)) continue;
    changes++;
    if (!x) console.log(`${t} new  ${label(spell)}: ${shown(y!)}`);
    else if (!y) console.log(`${t} gone ${label(spell)}`);
    else console.log(`${t} ${label(spell)}: ${Object.keys(y).filter((k) => x[k] !== y[k]).map((k) => `${k} ${x[k]} -> ${y[k]}`).join(", ")}`);
  }
}
for (const id of new Set([...ta.keys(), ...tb.keys()])) {
  const x = ta.get(id);
  const y = tb.get(id);
  if (JSON.stringify(x) === JSON.stringify(y)) continue;
  changes++;
  const s = label((y ?? x)!.spell);
  if (!x) console.log(`talent new  ${s}: ${y!.ranks} ranks at ${y!.pos}, ${y!.curves}`);
  else if (!y) console.log(`talent gone ${s}`);
  else {
    const what = (["ranks", "pos", "curves"] as const).filter((k) => x[k] !== y[k]).map((k) => `${k} ${x[k]} -> ${y[k]}`);
    console.log(`talent ${s}: ${what.join("; ")}`);
  }
}
if (!changes) console.log("no hunter rows changed");

// Overrides the new build would make stale: the loader rejects these once WOWF_BUILD moves.
const o = await loadOverrides();
const effects = new Map(b.SpellEffect.map((r) => [`${r.SpellID}|${r.EffectIndex}`, r]));
const stale: string[] = [];
for (const h of o.hotfix) {
  const e = effects.get(`${h.spell}|${h.effectIndex ?? 0}`);
  if (!e) continue;
  if (h.basePoints !== undefined && Number(e.EffectBasePointsF) === h.basePoints) stale.push(`hotfix ${label(String(h.spell))} effect ${h.effectIndex} basePoints ${h.basePoints}`);
  if (h.apCoefficient !== undefined && Number(e.BonusCoefficientFromAP) === h.apCoefficient) stale.push(`hotfix ${label(String(h.spell))} effect ${h.effectIndex} apCoefficient ${h.apCoefficient}`);
}
console.log(stale.length ? `\n${stale.length} overrides the new build already carries:\n  ${stale.join("\n  ")}` : "\nno base point or coefficient override is carried by the new build");
console.log("talent hotfixes are checked against the curves when WOWF_BUILD moves (bun test fails on a stale one)");
