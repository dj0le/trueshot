import { expect, test } from "bun:test";
import { loadGameData } from "@hunter-sim/data";
import { configBuild, fillBuild, searchBuilds, talentErrors, talentPoints, withBuild, type SimConfigInput } from "./index";

const game = await loadGameData();
const data = game.data;

const base: SimConfigInput = {
  race: "Orc",
  gear: { rangedWeapon: { min: 61, max: 114, speed: 2.8 }, stats: { hitPct: 9, mp5: 10000 } },
  fight: { durationSec: 60, iterations: 50 },
  rotation: { actions: [{ action: "aimed_shot" }, { action: "arcane_shot" }] },
};

test("a greedy fill spends every point and keeps to the talent rules", () => {
  for (const tree of ["Beast Mastery", "Marksmanship", "Survival"]) {
    const order = data.talents.filter((t) => t.tree === tree).sort((a, b) => a.row - b.row);
    const rest = data.talents.filter((t) => t.tree !== tree);
    const talents = fillBuild(data, 60, [...order, ...rest]);
    expect(talentErrors(data, 60, talents).errors).toEqual([]);
    expect(Object.values(talents).reduce((a, b) => a + b, 0)).toBe(talentPoints(60));
  }
  // Level 30 has 21 points.
  const low = fillBuild(data, 30, data.talents.filter((t) => t.tree === "Marksmanship").sort((a, b) => a.row - b.row));
  expect(Object.values(low).reduce((a, b) => a + b, 0)).toBe(21);
});

test("a build drops into a config: a new family loses the old family's ability list", () => {
  const config = { ...base, pet: { active: true, family: "Cat", abilities: ["claw"] } };
  expect(configBuild(config)).toEqual({ talents: {}, pet: "Cat" });
  expect(withBuild(config, { talents: { "Lethal Attacks": 5 }, pet: "Cat" }).pet).toMatchObject({ family: "Cat", abilities: ["claw"] });
  expect(withBuild(config, { talents: {}, pet: "Wolf" }).pet).toMatchObject({ active: true, family: "Wolf", abilities: undefined });
  expect(withBuild(config, { talents: {}, pet: null }).pet).toMatchObject({ active: false });
});

test("the search moves points out of talents that do nothing into ones that do", () => {
  // All five points in Endurance Training, pet health and armor, with no pet out.
  const config = { ...base, level: 14, talents: { "Endurance Training": 5 } };
  const r = searchBuilds(game, config, { iterations: 50, budget: 40, mutantsPerRound: 6, climbs: 1, configOnly: true, pets: false, seed: "t" });
  expect(r.best.talents["Endurance Training"] ?? 0).toBeLessThan(5);
  expect(talentErrors(data, 14, r.best.talents).errors).toEqual([]);
});
