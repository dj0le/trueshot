import { expect, test } from "bun:test";
import { loadGameData } from "@hunter-sim/data";
import {
  actionsToGenes,
  configBuild,
  defaultPetAbilities,
  fillBuild,
  genesToActions,
  optimizeBuild,
  searchBuilds,
  specOf,
  specTree,

  talentErrors,
  talentPoints,
  withBuild,
  type SimConfigInput,
} from "./index";

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
  const style = { position: "ranged" as const, weaveDelayMs: 1200 };
  expect(configBuild(config)).toEqual({ talents: {}, pet: "Cat", style });
  expect(withBuild(config, { talents: { "Lethal Attacks": 5 }, pet: "Cat", style }).pet).toMatchObject({ family: "Cat", abilities: ["claw"] });
  expect(withBuild(config, { talents: {}, pet: "Wolf", style }).pet).toMatchObject({ active: true, family: "Wolf", abilities: undefined });
  expect(withBuild(config, { talents: {}, pet: null, style }).pet).toMatchObject({ active: false });
  expect(withBuild(config, { talents: {}, pet: null, style: { position: "weave", weaveDelayMs: 600 } })).toMatchObject({
    position: "weave",
    weave: { maxAutoShotDelayMs: 600 },
  });
});

test("the search moves points out of talents that do nothing into ones that do", () => {
  // All five points in Endurance Training, pet health and armor, with no pet out.
  const config = { ...base, level: 14, talents: { "Endurance Training": 5 } };
  const r = searchBuilds(game, config, { iterations: 50, budget: 40, mutantsPerRound: 6, climbs: 1, configOnly: true, pets: false, styles: false, seed: "t" });
  expect(r.best.talents["Endurance Training"] ?? 0).toBeLessThan(5);
  expect(talentErrors(data, 14, r.best.talents).errors).toEqual([]);
});

test("a spec search starts deep in the spec when the config is not, and keeps every build there", () => {
  const config = { ...base, level: 30, talents: { "Lethal Attacks": 5 } };
  expect(specOf(data, config.talents)).toBe("Marksmanship");
  expect(specOf(data, { "Lethal Attacks": 2, "Endurance Training": 2 })).toBeNull();
  expect(specTree("sv")).toBe("Survival");
  const r = searchBuilds(game, config, { iterations: 30, budget: 30, mutantsPerRound: 6, climbs: 1, configOnly: false, pets: false, styles: false, spec: "Survival", seed: "t" });
  expect(specOf(data, r.best.talents)).toBe("Survival");
  expect(talentErrors(data, 30, r.best.talents).errors).toEqual([]);
  expect(() => searchBuilds(game, config, { iterations: 1, budget: 1, mutantsPerRound: 1, climbs: 1, configOnly: true, pets: false, styles: false, spec: "Frost", seed: "t" })).toThrow();
});

test("a rotation read into genes and back keeps the pet ability its macro sends", () => {
  const actions = [{ action: "intimidation", pet: "bite" }, { action: "serpent_sting", if: "!debuff.serpent_sting.up" }];
  expect(genesToActions(actionsToGenes(actions).genes)).toEqual(actions);
});

test("a combined search adds taught abilities, ends on a legal build, and confirms on the same fresh fights", () => {
  const config = { ...base, level: 14, talents: { "Endurance Training": 5 } };
  const r = optimizeBuild(game, config, {
    build: { iterations: 30, budget: 25, mutantsPerRound: 5, climbs: 1, pets: false, styles: false },
    rotation: { pool: ["arcane_shot"], iterations: 30, budget: 4, mutantsPerRound: 2, confirmIterations: 30 },
    rounds: 1,
    taught: { precombat: ["trueshot_aura"], actions: ["raptor_strike"] },
    confirmIterations: 40,
    seed: "t",
  });
  expect(talentErrors(data, 14, r.best.talents ?? {}).errors).toEqual([]);
  expect(r.build).toEqual(configBuild(r.best));
  expect(r.best.rotation.precombat).toContain("trueshot_aura");
  expect(r.confirm.before.iterations).toBe(40);
  expect(r.confirm.after.iterations).toBe(40);
  expect(r.confirm.delta).toBeCloseTo(r.confirm.after.dps.mean - r.confirm.before.dps.mean, 6);
});

test("a family's default pet abilities are what it autocasts without a list", () => {
  expect(defaultPetAbilities(data, "Cat", 60)).toEqual(expect.arrayContaining(["claw", "bite"]));
  expect(() => defaultPetAbilities(data, "Dragon", 60)).toThrow();
});
