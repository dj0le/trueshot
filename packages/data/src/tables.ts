// Where the fetched upstream files live, and the small helpers both build scripts use to read them.
import { join } from "node:path";
import { csvToRows, type Row } from "./csv";
import { CLASSIC_ERA_BUILD, WOWF_BUILD } from "./sources";

export const RAW_DIR = join(import.meta.dir, "..", "raw", WOWF_BUILD);
export const ERA_DIR = join(import.meta.dir, "..", "raw", `classic-era-${CLASSIC_ERA_BUILD}`);

// Loads tables by name into a record, so each is read by name rather than by position.
export async function tables<const N extends string>(names: readonly N[], dir = RAW_DIR): Promise<Record<N, Row[]>> {
  const loaded = await Promise.all(names.map(async (n) => [n, csvToRows(await Bun.file(join(dir, `${n}.csv`)).text())] as const));
  return Object.fromEntries(loaded) as Record<N, Row[]>;
}

export const num = (s: string | undefined) => {
  const n = Number(s ?? 0);
  // Floats come through as 0.07999999821; six places is far below anything the game resolves.
  return Number.isInteger(n) ? n : Math.round(n * 1e6) / 1e6;
};

export const byId = (rows: Row[]) => new Map(rows.map((r) => [r.ID!, r]));

export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const group = out.get(k);
    if (group) group.push(r);
    else out.set(k, [r]);
  }
  return out;
}

// Rows by spell, keeping only the base difficulty where the table has one.
export const bySpell = (rows: Row[]) =>
  groupBy(
    rows.filter((r) => (r.DifficultyID ?? "0") === "0"),
    (r) => r.SpellID!,
  );

// Forever joins items to effects through ItemXItemEffect; Classic Era keeps ParentItemID on the
// effect. Returns Forever's effect rows by item, with ParentItemID filled in as Classic Era has it.
export const effectsByItem = (links: Row[], effects: Row[]) => {
  const effectById = byId(effects);
  return groupBy(
    links.flatMap((x): Row[] => {
      const e = effectById.get(x.ItemEffectID!);
      return e ? [{ ...e, ParentItemID: x.ItemID! }] : [];
    }),
    (r) => r.ParentItemID!,
  );
};
