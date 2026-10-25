// Pins known values in generated/hunter.json, checked against the talentsforever tooltips.
// A failure after a build bump means the game changed or the normalizer broke; find out which.
import { expect, test } from "bun:test";
import data from "../generated/hunter.json";
import type { HunterData } from "./schema";

const d = data as unknown as HunterData;
const ability = (name: string) => d.abilities.find((a) => a.name === name)!;
const talent = (name: string) => d.talents.find((t) => t.name === name)!;
const topRank = (name: string) => d.spells[String(ability(name).ranks.at(-1)!.spellId)]!;

test("Aimed Shot is trainable with a 2 sec cast and a cooldown shared with Multi-Shot", () => {
  const aimed = topRank("Aimed Shot");
  const multi = topRank("Multi-Shot");
  expect(ability("Aimed Shot").ranks).toHaveLength(6);
  expect(aimed.castTimeMs).toBe(2000);
  expect(aimed.effects[0]!.basePoints).toBe(166);
  expect(aimed.category).toBe(multi.category);
  expect(aimed.categoryCooldownMs).toBe(6000);
});

test("instant shots have no cast time", () => {
  expect(topRank("Arcane Shot").castTimeMs).toBe(0);
  expect(topRank("Arcane Shot").effects[0]!.basePoints).toBe(217);
});

test("talent rank values come from the trait curves", () => {
  expect(talent("Mortal Shots").rankEffects[0]!.values).toEqual([6, 12, 18, 24, 30]);
  expect(talent("Mortal Shots").requires).toEqual(["Careful Aim"]);
  expect(talent("Sniper Shot")).toMatchObject({ tree: "Marksmanship", row: 7, col: 2, maxRank: 1 });
});

test("all three trees and the Forever pet family are present", () => {
  expect(new Set(d.talents.map((t) => t.tree))).toEqual(new Set(["Beast Mastery", "Marksmanship", "Survival"]));
  expect(d.talents).toHaveLength(50);
  expect(d.petFamilies.map((p) => p.name)).toContain("Fox");
});
