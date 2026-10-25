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
