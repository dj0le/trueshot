import { expect, test } from "bun:test";
import data from "../generated/hunter.json";
import { applyHotfixes, loadOverrides, unconfirmed } from "./overrides";
import type { HunterData } from "./schema";

const d = data as unknown as HunterData;

test("overrides.toml validates", async () => {
  const o = await loadOverrides();
  const lv = o.levels;
  // Level 60 rows match Classic's known values.
  expect(lv.hunter.races.Orc!.stats.at(-1)).toEqual([58, 122, 92, 62, 73]);
  expect(lv.hunter.baseMana.values.at(-1)).toBe(1720);
  expect(lv.creatureArmor.values.at(-1)).toBe(3731);
  expect(o.targets.boss!.levelOffset).toBe(3);
});

test("hotfixes replace effect base points without touching the input", async () => {
  const o = await loadOverrides();
  const patched = applyHotfixes(d, o);
  expect(patched.spells["14325"]!.effects[1]!.basePoints).toBe(143);
  expect(d.spells["14325"]!.effects[1]!.basePoints).toBe(71);
});

test("talent hotfixes follow the tooltip: weapon-only damage, Auto Shot-only procs", async () => {
  const patched = applyHotfixes(d, await loadOverrides());
  expect(patched.spells["19507"]!.effects[0]!.miscValue[0]).toBe(1);
  expect(patched.spells["25296"]!.proc!.typeMask[0]).toBe(0x40);
  expect(patched.spells["1293241"]!.effects[0]!.apCoefficient).toBe(0.05);
  // Efficiency no longer reaches Summon Hawk, and still reaches the shots.
  expect(patched.spells["19416"]!.effects[0]!.classMask[2]).toBe(0);
  expect(patched.spells["19416"]!.effects[0]!.classMask[0]).toBe(522818);
});

test("a hotfix the client already has is rejected as stale", async () => {
  const o = await loadOverrides();
  o.hotfix = [{ spell: 14325, effectIndex: 1, basePoints: 71, confidence: "reported", source: "test" }];
  expect(() => applyHotfixes(d, o)).toThrow(/already has 71/);
});

test("unconfirmed lists guesses with their keys", async () => {
  const keys = unconfirmed(await loadOverrides()).map((u) => u.key);
  expect(keys).toContain("levels.hunter.races.Human");
  expect(keys).toContain("pet.focusPerSecond");
  expect(keys).not.toContain("formula.autoShotStandStillMs");
});
