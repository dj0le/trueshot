import { expect, test } from "bun:test";
import { parsePicks, preset } from "./gearquest";
import type { Item, Suffix } from "./schema";

const LUA = `GQ.Data.hunterItemFacts = {}
GQ.Data.hunterPicks = {
    {1,"Ranged",28,31,1,"beast_mastery","Alliance",9.5},
    {2,"Ranged",28,31,2,"beast_mastery","Alliance",9.1,suffix="of Agility",suffixChance=9.3,suffixId=17,suffixRange="+4-5 Agility"},
    {3,"Ranged",28,31,3,"beast_mastery","Alliance",8.0,suffix="of Stamina",suffixChance=6,suffixRange="+1-2 Stamina"},
    {4,"Finger",28,31,1,"beast_mastery","Alliance",5},
    {5,"Finger",28,31,2,"beast_mastery","Alliance",4},
    {6,"MainHand",28,31,1,"beast_mastery","Alliance",4},
    {7,"SecondaryHand",28,31,1,"beast_mastery","Alliance",3},
    {8,"Ranged",32,35,1,"beast_mastery","Alliance",12},
}`;

const item = (id: number, inventoryType: number, requiredLevel = 25) => [id, { id, name: `Item ${id}`, inventoryType, requiredLevel } as Item] as const;
const items = new Map([item(1, 15, 40), item(2, 15), item(3, 15), item(4, 11), item(5, 11), item(6, 17), item(7, 13), item(8, 15)]);
const suffixes = new Map<number, Suffix>([[17, { id: 17, name: "of Agility", enchants: [75] }]]);

test("picks parse with their suffix id when the addon gives one", () => {
  const picks = parsePicks(LUA);
  expect(picks).toHaveLength(8);
  expect(picks[1]).toMatchObject({ itemId: 2, slot: "Ranged", minLevel: 28, maxLevel: 31, rank: 2, suffixId: 17, suffix: "of Agility" });
  expect(picks[2]!.suffixId).toBeUndefined();
});

test("a preset skips items the level cannot wear and suffixes without an id, pairs rings, and leaves the off hand to a one-hander", () => {
  const best = preset(parsePicks(LUA), items, suffixes, "beast_mastery", "Alliance", 30, 1);
  // Item 1 needs level 40, so the first wearable bow is item 2 with its suffix.
  expect(best.items).toEqual({ ranged: 2, finger1: 4, finger2: 5, mainHand: 6 });
  expect(best.suffixes).toEqual({ ranged: 17 });
  expect(best.names.ranged).toBe("Item 2 of Agility");
  // Past the list's end the last wearable pick stands in; item 3's suffix has no id.
  expect(preset(parsePicks(LUA), items, suffixes, "beast_mastery", "Alliance", 30, 4).items.ranged).toBe(2);
});
