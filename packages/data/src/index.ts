import { join } from "node:path";
import { applyHotfixes, loadOverrides, type Overrides } from "./overrides";
import type { Enchant, HunterData, Item } from "./schema";

export * from "./schema";
export * from "./overrides";

export const GENERATED_PATH = join(import.meta.dir, "..", "generated", "hunter.json");
export const ITEMS_PATH = join(import.meta.dir, "..", "generated", "items.json");
export const ENCHANTS_PATH = join(import.meta.dir, "..", "generated", "enchants.json");

export type GameData = { data: HunterData; overrides: Overrides; items: Map<number, Item>; enchants: Map<number, Enchant> };

// Client data with hotfixes applied, plus the overrides. The one entry point for the CLI.
export async function loadGameData(): Promise<GameData> {
  const overrides = await loadOverrides();
  const raw = (await Bun.file(GENERATED_PATH).json()) as HunterData;
  const items = (await Bun.file(ITEMS_PATH).json()) as Item[];
  const enchants = (await Bun.file(ENCHANTS_PATH).json()) as Enchant[];
  return {
    data: applyHotfixes(raw, overrides),
    overrides,
    items: new Map(items.map((i) => [i.id, i])),
    enchants: new Map(enchants.map((e) => [e.id, e])),
  };
}
