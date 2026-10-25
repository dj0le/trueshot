import { expect, test } from "bun:test";
import { loadGameData } from "@hunter-sim/data";
import { buildCharacter, SimConfig, simulate, type SimConfigInput } from "./index";

const game = await loadGameData();

const base: SimConfigInput = {
  race: "Orc",
  gear: { rangedWeapon: { min: 61, max: 114, speed: 2.8 }, stats: { hitPct: 9 } },
  fight: { durationSec: 600, iterations: 300 },
  rotation: { actions: [] },
};

test("auto shot alone matches the hand-calculated DPS", () => {
  const f = game.overrides.formula;
  const t = game.overrides.targets.boss!;
  const [, agility] = game.overrides.races.Orc!.stats;
  const rap = 60 * f.rangedAttackPowerPerLevel.value + agility * f.rangedAttackPowerPerAgility.value + f.rangedAttackPowerBase.value;
  const perShot = (61 + 114) / 2 + (rap / f.attackPowerPerDps.value) * 2.8;
  const armor = 1 - t.armor / (t.armor + f.armorConstantBase.value + f.armorConstantPerLevel.value * 60);
  // Orcs get Savage, +1% crit.
  const crit = (agility / f.agilityPerCrit.value + 1 - t.critSuppressionPct) / 100;
  // First shot after the 0.5 sec wind-up, then one every 2.8 sec.
  const shots = Math.floor((600 - 0.5) / 2.8) + 1;
  const expected = (perShot * armor * (1 + crit * (f.critDamageBonusPct.value / 100)) * shots) / 600;

  const r = simulate(game, base);
  expect(r.abilities.map((a) => a.name)).toEqual(["Auto Shot"]);
  expect(r.abilities[0]!.missPct).toBe(0);
  expect(r.abilities[0]!.castsPerFight).toBe(shots);
  expect(Math.abs(r.dps.mean - expected) / expected).toBeLessThan(0.005);
});

test("the same seed gives the same result, a different seed a different one", () => {
  const a = simulate(game, { ...base, fight: { durationSec: 60, iterations: 50, seed: "x" } });
  const b = simulate(game, { ...base, fight: { durationSec: 60, iterations: 50, seed: "x" } });
  const c = simulate(game, { ...base, fight: { durationSec: 60, iterations: 50, seed: "y" } });
  expect(a.dps.mean).toBe(b.dps.mean);
  expect(a.dps.mean).not.toBe(c.dps.mean);
});

test("Auto Shot keeps firing through Aimed Shot casts", () => {
  const r = simulate(game, {
    ...base,
    // Unlimited mana, so the cast count is set by the cooldown alone.
    gear: { ...base.gear!, stats: { hitPct: 9, mp5: 10000 } },
    fight: { durationSec: 600, iterations: 20 },
    rotation: { actions: [{ action: "aimed_shot" }] },
  });
  const auto = r.abilities.find((a) => a.name === "Auto Shot")!;
  const aimed = r.abilities.find((a) => a.name === "Aimed Shot")!;
  const uninterrupted = Math.floor((600 - 0.5) / 2.8) + 1;
  // The 6 sec cooldown starts when the 2 sec cast ends, so one cast every 8 sec at most.
  expect(aimed.castsPerFight).toBeGreaterThan(70);
  expect(aimed.castsPerFight).toBeLessThanOrEqual(600 / 8 + 1);
  expect(auto.castsPerFight).toBe(uninterrupted);
});

test("Bestial Discipline speeds up the pet's focus regen, so it uses Claw more", () => {
  const talents = { "Deadly Aspects": 5, "Endurance Training": 5, "Unleashed Fury": 5, Ferocity: 5 };
  const run = (extra: Record<string, number>) =>
    simulate(game, {
      ...base,
      talents: { ...talents, ...extra },
      pet: { active: true, family: "Cat", abilities: ["claw"] },
      fight: { durationSec: 600, iterations: 20 },
    }).abilities.find((a) => a.name === "Pet: Claw")!.castsPerFight;
  expect(run({ "Bestial Discipline": 2 })).toBeGreaterThan(run({}) * 1.1);
});

test("talent rules are enforced", () => {
  expect(() => simulate(game, { ...base, talents: { "Mortal Shots": 5 } })).toThrow(/needs 15 points/);
  expect(() => simulate(game, { ...base, talents: { "Hawk Eye": 4 } })).toThrow(/rank 4 but the talent has 3/);
  expect(() => simulate(game, { ...base, talents: { Nope: 1 } })).toThrow(/unknown talent "Nope"/);
});

test("rotation typos fail before any fight runs", () => {
  expect(() => simulate(game, { ...base, rotation: { actions: [{ action: "aimed_shoot" }] } })).toThrow(/unknown action/);
  expect(() =>
    simulate(game, { ...base, rotation: { actions: [{ action: "aimed_shot", if: "buff.quik_shots.up" }] } }),
  ).toThrow(/unknown spell "quik_shots"/);
});

test("Volley channels for 6 sec and its linked spell ticks every second", () => {
  const r = simulate(game, {
    ...base,
    gear: { ...base.gear!, stats: { hitPct: 9, mp5: 10000 } },
    fight: { durationSec: 60, iterations: 20 },
    rotation: { actions: [{ action: "volley" }] },
  });
  const volley = r.abilities.find((a) => a.name === "Volley")!;
  // Back to back channels: 10 casts in 60 sec, each tick rolling hit and crit on its own.
  expect(volley.castsPerFight).toBe(10);
  expect(volley.critPct).toBeGreaterThan(0);
  expect(volley.avgHit).toBeGreaterThan(112);
  // Auto Shot cannot fire while channeling.
  expect(r.abilities.find((a) => a.name === "Auto Shot")).toBeUndefined();
});

test("Rapid Recuperation keeps some regen going while Serpent Sting is up", () => {
  const talents = {
    "Lethal Attacks": 5,
    Efficiency: 5,
    "Careful Aim": 5,
    "Improved Arcane Shot": 5,
    "Rapid Killing": 2,
    "Mortal Shots": 5,
    "Rapid Recuperation": 2,
  };
  const setup = (t: Record<string, number>) =>
    simulate(game, {
      ...base,
      talents: t,
      fight: { durationSec: 180, iterations: 50 },
      rotation: { actions: [{ action: "serpent_sting", if: "!dot.serpent_sting.ticking" }, { action: "arcane_shot" }] },
    });
  const without = setup({ ...talents, "Rapid Recuperation": 0 });
  const withTalent = setup(talents);
  expect(withTalent.manaSpentPerFight).toBeGreaterThan(without.manaSpentPerFight);
});

test("a DoT gets all its ticks, including the one landing on expiry", () => {
  const r = simulate(game, {
    ...base,
    gear: { ...base.gear!, stats: { hitPct: 9, mp5: 100000 } },
    // Two full stings: cast at 0 and 15, ticks every 3 sec.
    fight: { durationSec: 30.1, iterations: 5 },
    rotation: { actions: [{ action: "serpent_sting", if: "!dot.serpent_sting.ticking & time < 20" }] },
  });
  const sting = r.abilities.find((a) => a.name === "Serpent Sting")!;
  expect(sting.castsPerFight).toBe(2);
  expect(sting.avgHit).toBeCloseTo(111 * 5, 5);
});

test("gear items add their stats, convert ratings, and supply the ranged weapon", () => {
  const ch = buildCharacter(game.data, game.overrides, game.items, SimConfig.parse({
    ...base,
    gear: { items: { head: 252605, chest: 252483, ranged: 18680 } },
  }));
  const [, agility] = game.overrides.races.Orc!.stats;
  // Helm 21 + Dawn Armor 37 + Ancient Bone Bow 11.
  expect(ch.primary.agility).toBe(agility + 21 + 37 + 11);
  // Dawn Armor's 10 hit rating is 1% hit.
  expect(ch.hitPct).toBeCloseTo(10 / game.overrides.formula.hitRatingPerPct.value, 5);
  expect(ch.rangedWeapon).toMatchObject({ min: 61, max: 114, speed: 2.8 });
  expect(ch.gearNotes.some((n) => n.startsWith("Ancient Bone Bow"))).toBe(true);
  expect(() =>
    buildCharacter(game.data, game.overrides, game.items, SimConfig.parse({ ...base, gear: { items: { neck: 252605 } } })),
  ).toThrow(/does not go in neck/);
});

test("reapplying a pet DoT replaces it instead of stacking", () => {
  // Scorpid Poison: 4 sec cooldown, 10 sec duration, a tick every 2 sec.
  const r = simulate(game, {
    ...base,
    pet: { active: true, family: "Scorpid", abilities: ["scorpid_poison"] },
    fight: { durationSec: 600, iterations: 5 },
  });
  const poison = r.abilities.find((a) => a.name === "Pet: Scorpid Poison")!;
  expect(poison.ticksPerFight).toBeGreaterThan(200);
  expect(poison.ticksPerFight).toBeLessThanOrEqual(600 / 2);
});

test("a condition that turns true with time alone is noticed within the reaction delay", () => {
  // No events land between 5.3 sec and the end of this fight, so only the re-check can cast it.
  const r = simulate(game, {
    ...base,
    fight: { durationSec: 5.5, iterations: 1 },
    rotation: { actions: [{ action: "arcane_shot", if: "time > 5.3" }] },
  });
  expect(r.abilities.find((a) => a.name === "Arcane Shot")?.castsPerFight).toBe(1);
});

test("Intimidation's crit buff is used up by the pet's next successful attack", () => {
  const talents = { "Deadly Aspects": 5, "Endurance Training": 5, "Bestial Swiftness": 1, "Unleashed Fury": 5, Ferocity: 5, Intimidation: 1 };
  const run = (actions: { action: string }[]) =>
    simulate(game, {
      ...base,
      talents,
      pet: { active: true, family: "Cat", abilities: [] },
      fight: { durationSec: 15, iterations: 200 },
      rotation: { actions },
    }).abilities.find((a) => a.name === "Pet: Melee")!;
  const without = run([]);
  const withIt = run([{ action: "intimidation" }]);
  // One extra crit at most in about 7 landed swings (it can still glance), not every swing for 15 sec.
  expect(withIt.critPct - without.critPct).toBeGreaterThan(2);
  expect(withIt.critPct - without.critPct).toBeLessThan(25);
});

test("a pet ability sent with Intimidation goes out at once and takes the guaranteed crit", () => {
  const talents = { "Deadly Aspects": 5, "Endurance Training": 5, "Bestial Swiftness": 1, "Unleashed Fury": 5, Ferocity: 5, Intimidation: 1 };
  const r = simulate(game, {
    ...base,
    talents,
    pet: { active: true, family: "Cat", abilities: [] },
    fight: { durationSec: 5, iterations: 50 },
    rotation: { actions: [{ action: "intimidation", pet: "bite" }] },
  });
  const bite = r.abilities.find((a) => a.name === "Pet: Bite")!;
  // Bite is not on autocast here, so the macro is its only cast; it crits whenever it lands.
  expect(bite.castsPerFight).toBe(1);
  expect(bite.critPct).toBe(100);
  expect(() => simulate(game, { ...base, talents, pet: { active: true, family: "Cat" }, rotation: { actions: [{ action: "intimidation", pet: "rend" }] } })).toThrow(
    /does not know "rend"/,
  );
});

test("a pet attacking half the fight does about half its damage", () => {
  const run = (attackingPct: number) =>
    simulate(game, { ...base, pet: { active: true, family: "Cat", attackingPct }, fight: { durationSec: 120, iterations: 100 } })
      .abilities.filter((a) => a.name.startsWith("Pet:"))
      .reduce((s, a) => s + a.dps, 0);
  const ratio = run(50) / run(100);
  expect(ratio).toBeGreaterThan(0.45);
  expect(ratio).toBeLessThan(0.55);
  expect(run(0)).toBe(0);
});

test("support presets add outside mana, and the raid's Judgement of Wisdom pays out per hit", () => {
  // Serpent Sting on every GCD runs a solo hunter dry.
  const spam = { ...base, fight: { durationSec: 120, iterations: 50 }, rotation: { actions: [{ action: "serpent_sting" }] } };
  const solo = simulate(game, spam);
  const party = simulate(game, { ...spam, support: "party" });
  const raid = simulate(game, { ...spam, support: "raid" });
  expect(party.manaSpentPerFight).toBeGreaterThan(solo.manaSpentPerFight);
  expect(raid.manaSpentPerFight).toBeGreaterThan(party.manaSpentPerFight);
  expect(() => simulate(game, { ...spam, support: "nope" })).toThrow(/unknown preset/);
});

test("hunter talents do not modify other classes' support spells", () => {
  // Bestial Swiftness's modifier shares a mask bit with Blessing of Wisdom in the paladin family.
  const spam = { ...base, fight: { durationSec: 120, iterations: 50 }, support: "party", rotation: { actions: [{ action: "serpent_sting" }] } };
  const talents = { "Deadly Aspects": 5, "Endurance Training": 1, "Focused Fire": 2, "Improved Aspect of the Monkey": 2 };
  const without = simulate(game, { ...spam, talents });
  const withIt = simulate(game, { ...spam, talents: { ...talents, "Bestial Swiftness": 1 } });
  expect(withIt.manaSpentPerFight).toBe(without.manaSpentPerFight);
});

test("a mana potion is an off-GCD action on a 2 minute item cooldown", () => {
  const r = simulate(game, {
    ...base,
    fight: { durationSec: 300, iterations: 20 },
    rotation: { actions: [{ action: "major_mana_potion", if: "mana.deficit > 2250" }, { action: "arcane_shot" }] },
  });
  const potion = r.abilities.find((a) => a.name === "Major Mana Potion")!;
  const arcane = r.abilities.find((a) => a.name === "Arcane Shot")!;
  expect(potion.castsPerFight).toBeGreaterThanOrEqual(2);
  expect(potion.castsPerFight).toBeLessThanOrEqual(3);
  expect(potion.dps).toBe(0);
  expect(arcane.castsPerFight).toBeGreaterThan(0);
});

test("conditions can name a consumable's cooldown by its action name", () => {
  const r = simulate(game, {
    ...base,
    fight: { durationSec: 300, iterations: 5 },
    rotation: {
      actions: [{ action: "major_mana_potion", if: "cooldown.major_mana_potion.ready & casts.major_mana_potion < 1" }],
    },
  });
  expect(r.abilities.find((a) => a.name === "Major Mana Potion")!.castsPerFight).toBe(1);
});

test("racials: Wind Blessed hastes Auto Shot, Berserking is cast, Savage adds crit", () => {
  const fight = { durationSec: 300, iterations: 20 };
  const autos = (race: string) =>
    simulate(game, { ...base, race, fight }).abilities.find((a) => a.name === "Auto Shot")!.castsPerFight;
  expect(autos("Skyborne")).toBeGreaterThan(autos("Tauren") * 1.025);

  const troll = simulate(game, { ...base, race: "Troll", fight, rotation: { actions: [{ action: "berserking" }] } });
  expect(troll.abilities.find((a) => a.name === "Berserking")!.castsPerFight).toBe(2);

  const orc = buildCharacter(game.data, game.overrides, game.items, SimConfig.parse({ ...base, race: "Orc" }));
  expect(orc.passives.map((p) => p.source)).toContain("Savage");
  expect(orc.abilities.has("blood_fury")).toBe(true);
});
