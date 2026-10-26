import { expect, test } from "bun:test";
import { loadGameData } from "@hunter-sim/data";
import { buildCharacter, fightLength, SimConfig, simulate, type SimConfigInput } from "./index";
import { attackTable } from "./levels";

const game = await loadGameData();

const base: SimConfigInput = {
  race: "Orc",
  gear: { rangedWeapon: { min: 61, max: 114, speed: 2.8 }, stats: { hitPct: 9 } },
  fight: { durationSec: 600, iterations: 300 },
  rotation: { actions: [] },
};

test("auto shot alone matches the hand-calculated DPS", () => {
  const f = game.overrides.formula;
  const lv = game.overrides.levels;
  const armor63 = lv.creatureArmor.values.at(-1)!;
  const [, agility] = lv.hunter.races.Orc!.stats.at(-1)!;
  const rap = 60 * f.rangedAttackPowerPerLevel.value + agility * f.rangedAttackPowerPerAgility.value + f.rangedAttackPowerBase.value;
  const perShot = (61 + 114) / 2 + (rap / f.attackPowerPerDps.value) * 2.8;
  const armor = 1 - armor63 / (armor63 + f.armorConstantBase.value + f.armorConstantPerLevel.value * 60);
  // Orcs get Savage, +1% crit from an aura. A boss three levels up takes 1% per level, and up to
  // 1.8% more off aura crit: a naked hunter is left with almost none.
  const savage = 1;
  const auraLoss = Math.min(savage, f.auraCritSuppressionPct.value);
  const crit = Math.max(0, agility / lv.hunter.agilityPerCrit.values.at(-1)! + savage - 3 * f.critSuppressionPerLevelPct.value - auraLoss) / 100;
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
    // Some gear crit, since a naked hunter barely crits a boss.
    gear: { ...base.gear!, stats: { hitPct: 9, mp5: 10000, critPct: 5 } },
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
  const ch = buildCharacter(game.data, game.overrides, game.items, game.enchants, SimConfig.parse({
    ...base,
    gear: { items: { head: 252605, chest: 252483, ranged: 18680 } },
  }));
  const [, agility] = game.overrides.levels.hunter.races.Orc!.stats.at(-1)!;
  // Helm 21 + Dawn Armor 37 + Ancient Bone Bow 11.
  expect(ch.primary.agility).toBe(agility + 21 + 37 + 11);
  // Dawn Armor's 10 hit rating is 1% hit.
  expect(ch.hitPct).toBeCloseTo(10 / game.overrides.formula.hitRatingPerPct.value, 5);
  expect(ch.rangedWeapon).toMatchObject({ min: 61, max: 114, speed: 2.8 });
  expect(ch.gearNotes.some((n) => n.startsWith("Ancient Bone Bow"))).toBe(true);
  expect(() =>
    buildCharacter(game.data, game.overrides, game.items, game.enchants, SimConfig.parse({ ...base, gear: { items: { neck: 252605 } } })),
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

test("the attack table follows the level gap", () => {
  const f = game.overrides.formula;
  const boss = attackTable(f, 60, 63);
  expect(boss).toMatchObject({ missPct: 8, spellMissPct: 17, hitPenaltyPct: 1, critSuppressionPct: 3, auraCritSuppressionPct: 1.8, dodgePct: 6.5, glancingPct: 40 });
  expect(boss.glancingPenaltyPct).toBeCloseTo(35, 5);
  expect(attackTable(f, 30, 32)).toMatchObject({ missPct: 6, hitPenaltyPct: 0, critSuppressionPct: 2, auraCritSuppressionPct: 0 });
  expect(attackTable(f, 30, 30)).toMatchObject({ missPct: 5, spellMissPct: 4, critSuppressionPct: 0, glancingPct: 10 });
});

test("a level 30 hunter knows level 30 ranks, has level 30 stats, and fights a level 30 target", () => {
  const ch = buildCharacter(game.data, game.overrides, game.items, game.enchants, SimConfig.parse({ ...base, level: 30, gear: { rangedWeapon: { min: 20, max: 38, speed: 2.8 } } }));
  expect(ch.primary.agility).toBe(game.overrides.levels.hunter.races.Orc!.stats[20]![1]);
  expect(ch.baseMana).toBe(775);
  // Aimed Shot's level 28 rank, not the level 60 one.
  expect(ch.abilities.get("aimed_shot")!.id).toBe(20900);
  const r = simulate(game, { ...base, level: 30, target: { preset: "normal" }, gear: { rangedWeapon: { min: 20, max: 38, speed: 2.8 } } });
  expect(r.abilities[0]!.missPct).toBeGreaterThan(0);
  expect(() => simulate(game, { ...base, level: 30, gear: { items: { ranged: 18680 } } })).toThrow(/needs level/);
});

test("Improved Arcane Shot shortens Arcane Shot's own cooldown, not the one Summon Hawk shares", () => {
  const talents = { "Lethal Attacks": 5, Efficiency: 5, "Improved Arcane Shot": 5, "Deadly Aspects": 5, "Endurance Training": 5, "Bestial Swiftness": 1, "Unleashed Fury": 5, "Summon Hawk": 1 };
  const run = (actions: { action: string; if?: string }[], durationSec: number) =>
    simulate(game, {
      ...base,
      talents,
      gear: { ...base.gear!, stats: { hitPct: 9, mp5: 10000 } },
      pet: { active: true, family: "Cat" },
      fight: { durationSec, iterations: 5 },
      rotation: { actions },
    }).abilities;
  // Arcane alone comes back every 4.5 sec.
  const arcane = run([{ action: "arcane_shot" }], 60).find((a) => a.name === "Arcane Shot")!;
  expect(arcane.castsPerFight).toBe(14);
  // One Arcane at 0, then Summon Hawk from 6 sec, not 4.5: at 6, 12 ... 54, nine casts, not ten.
  const both = run([{ action: "arcane_shot", if: "casts.arcane_shot < 1" }, { action: "summon_hawk" }], 60);
  expect(both.find((a) => a.name === "Summon Hawk")!.castsPerFight).toBe(9);
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

  const orc = buildCharacter(game.data, game.overrides, game.items, game.enchants, SimConfig.parse({ ...base, race: "Orc" }));
  expect(orc.passives.map((p) => p.source)).toContain("Savage");
  expect(orc.abilities.has("blood_fury")).toBe(true);
});

test("Improved Tracking adds 5% to all the hunter's damage against a type it can track", () => {
  const run = (creatureType: "humanoid" | "mechanical", rank: number) =>
    simulate(game, {
      ...base,
      talents: { "Improved Tracking": rank },
      target: { preset: "boss", creatureType },
      fight: { durationSec: 60, iterations: 20 },
      rotation: { actions: [{ action: "serpent_sting", if: "!dot.serpent_sting.ticking" }] },
    }).dps.mean;
  expect(run("humanoid", 5) / run("humanoid", 0)).toBeCloseTo(1.05, 6);
  expect(run("mechanical", 5)).toBe(run("mechanical", 0));
});

test("hawks and the dive get Unleashed Fury and Ferocity, but not Bestial Wrath", () => {
  const bm = { "Deadly Aspects": 5, "Endurance Training": 5, "Bestial Swiftness": 1, "Unleashed Fury": 5, "Summon Hawk": 1 };
  const run = (talents: Record<string, number>, precombat: string[] = [], preset: "boss" | "normal" = "boss") =>
    simulate(game, {
      ...base,
      talents,
      gear: { ...base.gear!, stats: { hitPct: 9, mp5: 10000 } },
      pet: { active: true, family: "Cat", abilities: [] },
      target: { preset },
      fight: { durationSec: 15, iterations: 200 },
      rotation: { precombat, actions: [{ action: "summon_hawk" }] },
    }).abilities;
  const dps = (r: ReturnType<typeof run>, name: string) => r.find((a) => a.name === name)!.dps;

  const withUf = run(bm);
  // The points go to talents that do nothing here, to keep Summon Hawk reachable.
  const withoutUf = run({ ...bm, "Unleashed Fury": 0, Pathfinding: 2, "Improved Revive Pet": 2, "Improved Aspect of the Monkey": 1 });
  expect(dps(withUf, "Summon Hawk") / dps(withoutUf, "Summon Hawk")).toBeCloseTo(1.15, 6);
  expect(dps(withUf, "Hawk: Attack") / dps(withoutUf, "Hawk: Attack")).toBeCloseTo(1.15, 6);

  const wrath = { ...bm, Ferocity: 5, "Bestial Discipline": 2, Intimidation: 1, Frenzy: 5, "Spirit Bond": 2, "Bestial Wrath": 1, "Improved Aspect of the Monkey": 3, "Focused Fire": 2 };
  const calm = run(wrath);
  const raging = run(wrath, ["bestial_wrath"]);
  expect(dps(raging, "Hawk: Attack")).toBe(dps(calm, "Hawk: Attack"));
  expect(dps(raging, "Pet: Melee") / dps(calm, "Pet: Melee")).toBeGreaterThan(1.3);

  // Against a same-level target nothing suppresses crit, so Ferocity's 10% shows in full.
  const ferocity = run({ ...bm, Ferocity: 5 }, [], "normal").find((a) => a.name === "Summon Hawk")!.critPct;
  const none = run(bm, [], "normal").find((a) => a.name === "Summon Hawk")!.critPct;
  expect(ferocity - none).toBeGreaterThan(7);
  expect(ferocity - none).toBeLessThan(13);
});

test("pets autocast every damage ability they know, and magic ones miss on the spell table", () => {
  const pet = (family: string) =>
    simulate(game, { ...base, pet: { active: true, family }, fight: { durationSec: 120, iterations: 50 } }).abilities.filter((a) => a.name.startsWith("Pet:"));
  expect(pet("Crab").map((a) => a.name)).toContain("Pet: Pinch");
  expect(pet("Gorilla").map((a) => a.name)).toContain("Pet: Thunderstomp");
  // Prowl needs stealth before the pull; it stays off.
  expect(pet("Cat").map((a) => a.name)).not.toContain("Pet: Prowl");
  const breath = pet("Wind Serpent").find((a) => a.name === "Pet: Lightning Breath")!;
  expect(breath.missPct).toBeGreaterThan(14);
  expect(breath.missPct).toBeLessThan(20);
});

test("pet autocast puts long cooldowns first and leaves out openers and abilities that do no damage", () => {
  const pet = (family: string) =>
    simulate(game, { ...base, pet: { active: true, family }, fight: { durationSec: 120, iterations: 50 } }).abilities.filter((a) => a.name.startsWith("Pet:"));
  // Mine! (90 sec) goes out at the pull and again at 90 sec, ahead of the Claw filler.
  const bird = pet("Bird of Prey");
  expect(bird.find((a) => a.name === "Pet: Mine!")!.castsPerFight).toBe(2);
  expect(bird.map((a) => a.name)).not.toContain("Pet: Dive");
  // Web deals its damage as ticks; a Web that lands counts as a hit, not a miss.
  const web = pet("Spider").find((a) => a.name === "Pet: Web")!;
  expect(web.ticksPerFight).toBeGreaterThan(0);
  expect(web.missPct).toBeLessThan(30);
  expect(pet("Boar").map((a) => a.name)).not.toContain("Pet: Charge");
});

test("set bonuses turn on by pieces worn, and enchants add stats and scope damage", () => {
  // Beaststalker Bindings, Gloves and Pants: three pieces, so +30 ranged attack power (and resistances).
  const three = { wrist: 16681, hands: 16676, legs: 16678 };
  const ch = (items: Record<string, number>, enchants: Record<string, number> = {}) =>
    buildCharacter(game.data, game.overrides, game.items, game.enchants, SimConfig.parse({ ...base, gear: { ...base.gear!, items, enchants } }));
  const sources = (items: Record<string, number>) => ch(items).passives.map((p) => p.source);
  expect(sources(three)).toEqual(expect.arrayContaining(["Beaststalker Armor (2)", "Beaststalker Armor (3)"]));
  expect(sources({ wrist: 16681, hands: 16676 })).not.toContain("Beaststalker Armor (3)");

  // +15 agility on the gloves, +3% hit on the bow's scope slot, and a +7 damage scope.
  const plain = ch({ ranged: 18680 });
  const enchanted = ch({ ranged: 18680 }, { hands: 2564, ranged: 664 });
  expect(enchanted.primary.agility - plain.primary.agility).toBe(15);
  expect(enchanted.rangedWeapon.min - plain.rangedWeapon.min).toBe(7);
  expect(ch({}, { head: 2523 }).hitPct).toBe(base.gear!.stats!.hitPct! + 3);
  expect(() => ch({}, { head: 999999 })).toThrow(/enchant 999999 on head/);
});

test("on-use trinkets keep their own cooldowns and lock each other out for 20 sec", () => {
  const run = (durationSec: number) =>
    simulate(game, {
      ...base,
      gear: { ...base.gear!, items: { trinket1: 21180 } },
      fight: { durationSec, iterations: 1 },
      rotation: { actions: [{ action: "earthstrike" }] },
    });
  expect(run(130).abilities.find((a) => a.name === "Earthstrike")!.castsPerFight).toBe(2);
  const both = (durationSec: number) =>
    simulate(game, {
      ...base,
      gear: { ...base.gear!, items: { trinket1: 21180, trinket2: 23041 } },
      fight: { durationSec, iterations: 1 },
      rotation: { actions: [{ action: "earthstrike" }, { action: "slayers_crest" }] },
    }).abilities;
  const casts = (r: ReturnType<typeof both>, name: string) => r.find((a) => a.name === name)?.castsPerFight ?? 0;
  // Earthstrike at 0, Slayer's Crest only once the 20 sec lockout is over, Earthstrike again at 120.
  expect(casts(both(19), "Slayer's Crest")).toBe(0);
  expect(casts(both(21), "Slayer's Crest")).toBe(1);
  expect(casts(both(130), "Earthstrike")).toBe(2);
});

test("stacking trinket buffs end with the buff that grants them", () => {
  const run = (trinket: number, action: string | null, durationSec: number) =>
    simulate(game, {
      ...base,
      gear: { ...base.gear!, items: trinket ? { trinket1: trinket } : {} },
      fight: { durationSec, iterations: 200 },
      rotation: { actions: action ? [{ action, if: "casts." + action + " < 1" }] : [] },
    });
  // Jom Gabbar: +65 attack power and 65 more every 2 sec for 20 sec, then nothing. Over 120 sec the
  // gain is a sixth of what 20 sec of it gives.
  const plain20 = run(0, null, 20).dps.mean;
  const plain120 = run(0, null, 120).dps.mean;
  const gain20 = run(23570, "jom_gabbar", 20).dps.mean - plain20;
  const gain120 = run(23570, "jom_gabbar", 120).dps.mean - plain120;
  expect(gain20).toBeGreaterThan(0);
  expect(gain120).toBeLessThan(gain20 / 4);
  expect(run(23570, "jom_gabbar", 20).unimplemented).toEqual([]);
  // Badge of the Swarmguard's armor penetration likewise ends after its 30 sec.
  const badge30 = run(21670, "badge_of_the_swarmguard", 30).dps.mean - run(0, null, 30).dps.mean;
  const badge180 = run(21670, "badge_of_the_swarmguard", 180).dps.mean - run(0, null, 180).dps.mean;
  expect(badge30).toBeGreaterThan(0);
  expect(badge180).toBeLessThan(badge30 / 3);
});

test("attack power against a creature type counts only against that type", () => {
  const run = (creatureType: "undead" | "humanoid", items: Record<string, number>) =>
    simulate(game, { ...base, gear: { ...base.gear!, items }, target: { preset: "boss", creatureType }, fight: { durationSec: 60, iterations: 20 } }).dps.mean;
  // Seal of the Dawn: +78 attack power against undead.
  expect(run("undead", { trinket1: 13209 })).toBeGreaterThan(run("undead", {}));
  expect(run("humanoid", { trinket1: 13209 })).toBe(run("humanoid", {}));
});

test("a ranged weapon's chance-on-hit effect procs from ranged hits", () => {
  // Dark Iron Rifle: Shadow Shot.
  const r = simulate(game, { ...base, gear: { items: { ranged: 16004 }, stats: { hitPct: 9 } }, fight: { durationSec: 600, iterations: 20 } });
  const shot = r.abilities.find((a) => a.name === "Shadow Shot")!;
  expect(shot.dps).toBeGreaterThan(0);
  expect(r.unimplemented.some((u) => u.includes("chance-on-hit"))).toBe(false);
});

test("in melee the hunter swings instead of shooting, and each side's abilities are out of range from the other", () => {
  const items = { mainHand: 18520, ranged: 18680 }; // Barbarous Blade, 3.2 sec
  const run = (position: "melee" | "ranged", actions: { action: string }[]) =>
    simulate(game, {
      ...base,
      position,
      gear: { items, stats: { hitPct: 9, mp5: 10000 } },
      fight: { durationSec: 320, iterations: 20 },
      rotation: { actions },
    }).abilities;
  const find = (r: ReturnType<typeof run>, name: string) => r.find((a) => a.name === name);
  const melee = run("melee", [{ action: "arcane_shot" }, { action: "raptor_strike" }]);
  expect(find(melee, "Auto Shot")).toBeUndefined();
  expect(find(melee, "Arcane Shot")).toBeUndefined();
  // 100 swings in 320 sec; Raptor Strike takes the place of a white swing whenever it is ready.
  const swings = find(melee, "Melee")!.castsPerFight + find(melee, "Raptor Strike")!.castsPerFight;
  expect(swings).toBe(100);
  expect(find(melee, "Raptor Strike")!.castsPerFight).toBeGreaterThan(40);
  const ranged = run("ranged", [{ action: "raptor_strike" }]);
  expect(find(ranged, "Raptor Strike")).toBeUndefined();
  expect(find(ranged, "Melee")).toBeUndefined();
});

test("Strider Kick multiplies its weapon damage by its percent instead of adding the two", () => {
  const r = simulate(game, {
    ...base,
    position: "melee",
    talents: { "Improved Tracking": 5, "Savage Strikes": 2, Survivalist: 5, Surefooted: 3, "Clever Traps": 2, "Survival Tactics": 2, "Predator's Edge": 1, "Strider Kick": 1 },
    gear: { items: { mainHand: 18520, ranged: 18680 }, stats: { hitPct: 9, mp5: 10000 } },
    fight: { durationSec: 300, iterations: 20 },
    rotation: { actions: [{ action: "strider_kick" }, { action: "raptor_strike" }] },
  }).abilities;
  const kick = r.find((a) => a.name === "Strider Kick")!.avgHit;
  const raptor = r.find((a) => a.name === "Raptor Strike")!.avgHit;
  // 100% of a 3.3 sec normalized hit against a 3.2 sec hit plus 70: close, not double.
  expect(kick / raptor).toBeGreaterThan(0.8);
  expect(kick / raptor).toBeLessThan(1.1);
});

test("Expose Prey opens Mongoose Bite only against a Hunter's Marked target", () => {
  const sv = { "Improved Tracking": 5, "Savage Strikes": 2, Survivalist: 5, Surefooted: 3, "Clever Traps": 2, "Survival Tactics": 2, "Predator's Edge": 3, "Expose Prey": 2 };
  const run = (mark: boolean) =>
    simulate(game, {
      ...base,
      position: "melee",
      talents: sv,
      gear: { items: { mainHand: 18520, ranged: 18680 }, stats: { hitPct: 9, mp5: 10000 } },
      fight: { durationSec: 300, iterations: 20 },
      rotation: { actions: [...(mark ? [{ action: "hunters_mark", if: "!debuff.hunters_mark.up" }] : []), { action: "mongoose_bite" }] },
    }).abilities.find((a) => a.name === "Mongoose Bite")?.castsPerFight ?? 0;
  expect(run(false)).toBe(0);
  // About 88 landed white swings at 10%: some 9 activations.
  expect(run(true)).toBeGreaterThan(6);
  expect(run(true)).toBeLessThan(13);
});

test("dual wielding adds off-hand swings at half damage and misses more", () => {
  const run = (items: Record<string, number>) =>
    simulate(game, { ...base, position: "melee", gear: { items: { ...items, ranged: 18680 }, stats: { hitPct: 9 } }, fight: { durationSec: 300, iterations: 50 } }).abilities;
  const longsword = 12584; // 2.9 sec, 138-207
  const one = run({ mainHand: longsword });
  const two = run({ mainHand: longsword, offHand: longsword });
  const mh = (r: ReturnType<typeof run>) => r.find((a) => a.name === "Melee")!;
  const oh = two.find((a) => a.name === "Melee (off hand)")!;
  expect(mh(two).missPct - mh(one).missPct).toBeCloseTo(game.overrides.formula.dualWieldMissPct.value, 0);
  expect(oh.avgHit / mh(two).avgHit).toBeCloseTo(0.5, 1);
});

test("weaving walks in for one swing between Auto Shots, only when the Auto Shot delay allows", () => {
  const run = (maxAutoShotDelayMs: number, enchants: Record<string, number> = {}) =>
    simulate(game, {
      ...base,
      position: "weave",
      weave: { maxAutoShotDelayMs },
      gear: { items: { mainHand: 18520, ranged: 18680 }, enchants, quiverHastePct: 15, stats: { hitPct: 9, mp5: 10000 } },
      fight: { durationSec: 300, iterations: 20 },
      rotation: { actions: [{ action: "raptor_strike" }] },
    }).abilities;
  const casts = (r: ReturnType<typeof run>, name: string) => r.find((a) => a.name === name)?.castsPerFight ?? 0;
  const ranged = simulate(game, { ...base, gear: { items: { mainHand: 18520, ranged: 18680 }, quiverHastePct: 15, stats: { hitPct: 9 } }, fight: { durationSec: 300, iterations: 20 } });
  const rangedAutos = ranged.abilities.find((a) => a.name === "Auto Shot")!.castsPerFight;

  // Walking 7 yards each way takes 2 sec, plus reactions: more than the 1.9 sec between an Auto Shot
  // and the next wind-up of a 2.8 sec bow with a 15% quiver, so a zero delay never weaves.
  const none = run(0);
  expect(casts(none, "Melee weave")).toBe(0);
  expect(casts(none, "Auto Shot")).toBe(rangedAutos);

  const weaving = run(1200);
  const weaves = casts(weaving, "Melee weave");
  expect(weaves).toBeGreaterThan(30);
  // One main-hand swing per weave, Raptor Strike whenever it is ready.
  expect(casts(weaving, "Melee") + casts(weaving, "Raptor Strike")).toBe(weaves);
  expect(casts(weaving, "Auto Shot")).toBeLessThan(rangedAutos);

  // Minor Speed boots: 8% faster legs, so more weaves fit.
  expect(casts(run(1200, { feet: 911 }), "Melee weave")).toBeGreaterThanOrEqual(weaves);
});

test("fire traps spring only when placed in melee, and Clever Traps and Survival Tactics improve them", () => {
  const sv = { "Improved Tracking": 5, "Savage Strikes": 2, Survivalist: 3, "Clever Traps": 2, Surefooted: 3 };
  const run = (position: "melee" | "ranged", talents: Record<string, number>) =>
    simulate(game, {
      ...base,
      position,
      talents,
      target: { preset: "boss" },
      gear: { items: { mainHand: 18520, ranged: 18680 }, stats: { hitPct: 9, mp5: 10000 } },
      fight: { durationSec: 300, iterations: 100 },
      rotation: { actions: [{ action: "immolation_trap" }] },
    }).abilities.find((a) => a.name === "Immolation Trap");
  // Out of reach the trap is never placed.
  expect(run("ranged", {})).toBeUndefined();
  const plain = run("melee", {})!;
  // Ten placements on a 30 sec cooldown; magic misses 17% against a boss.
  expect(plain.castsPerFight).toBe(10);
  expect(plain.missPct).toBeGreaterThan(14);
  expect(plain.missPct).toBeLessThan(20);
  // Clever Traps: 30% more per tick.
  const clever = run("melee", sv)!;
  expect(clever.avgHit / plain.avgHit).toBeCloseTo(1.3, 1);
  // Survival Tactics: 10% less to miss.
  const tactics = run("melee", { ...sv, "Survival Tactics": 2 })!;
  expect(plain.missPct - tactics.missPct).toBeGreaterThan(7);
});

test("Lacerating Strikes bleeds 40% of each Mongoose Bite, rolling what is left into a refresh", () => {
  const talents = {
    "Improved Tracking": 5,
    "Savage Strikes": 2,
    Survivalist: 5,
    Surefooted: 3,
    "Clever Traps": 2,
    "Survival Tactics": 2,
    "Predator's Edge": 5,
    "Expose Prey": 2,
    "Lightning Reflexes": 5,
    "Lacerating Strikes": 1,
  };
  const r = simulate(game, {
    ...base,
    position: "melee",
    talents,
    gear: { items: { mainHand: 18520, ranged: 18680 }, stats: { hitPct: 9, mp5: 10000 } },
    fight: { durationSec: 600, iterations: 20 },
    rotation: { actions: [{ action: "hunters_mark", if: "!debuff.hunters_mark.up" }, { action: "mongoose_bite" }] },
  }).abilities;
  const bite = r.find((a) => a.name === "Mongoose Bite")!.dps;
  const bleed = r.find((a) => a.name === "Lacerating Strikes")!.dps;
  // Bites land every few seconds on a 21 sec bleed, so most refresh a live one. Only the last
  // bleed's unticked damage is lost when the fight ends.
  expect(bleed / bite).toBeGreaterThan(0.37);
  expect(bleed / bite).toBeLessThanOrEqual(0.4);
});

test("a proc with an internal cooldown fires at most once per cooldown", () => {
  // Satchel of Copper Bombs throws a Small Bomb with every Auto Shot; give that proc a 10 sec cooldown.
  const id = "1318034";
  const satchel = game.data.spells[id]!;
  const withCooldown = {
    ...game,
    data: { ...game.data, spells: { ...game.data.spells, [id]: { ...satchel, proc: { ...satchel.proc!, categoryRecoveryMs: 10000 } } } },
  };
  const config = { ...base, gear: { items: { ranged: 285275 }, stats: { hitPct: 9 } }, fight: { durationSec: 60, iterations: 5 } };
  const bombs = (g: typeof game) => simulate(g, config).abilities.find((a) => a.name === "Small Bomb")!.castsPerFight;
  expect(bombs(game)).toBeGreaterThan(20);
  // One at the first Auto Shot, then one at the first shot 10 sec or more after the last.
  expect(bombs(withCooldown)).toBeGreaterThanOrEqual(5);
  expect(bombs(withCooldown)).toBeLessThanOrEqual(6);
});

test("an equip proc that says \"a chance\" over a client chance of every hit runs at the weapon proc rate", () => {
  // Hurricane: "Chance to strike your target with a Frost Arrow"; the client chance is 100.
  const r = simulate(game, { ...base, gear: { items: { ranged: 2824 }, stats: { hitPct: 9 } }, fight: { durationSec: 600, iterations: 20 } });
  const arrows = r.abilities.find((a) => a.name === "Frost Arrow")!.castsPerFight;
  const ppm = game.overrides.formula.weaponProcPpm.value;
  expect(arrows).toBeGreaterThan(ppm * 10 * 0.5);
  expect(arrows).toBeLessThan(ppm * 10 * 1.5);
  expect(r.unimplemented.some((u) => u.includes("Frost Arrow: proc rate is set by the server"))).toBe(true);
});

test("a proc whose tooltip says critical strikes fires on crits only", () => {
  // Cryptstalker 6 pieces: "Your ranged critical hits cause an Adrenaline Rush, granting you 50 mana".
  expect(game.data.spells["28752"]!.proc!.critOnly).toBe(true);
  const six = { head: 22438, shoulder: 22439, chest: 22436, hands: 22441, waist: 22442, legs: 22437 };
  const arcanes = (g: typeof game, items: Record<string, number>) =>
    simulate(g, {
      ...base,
      gear: { ...base.gear!, items },
      fight: { durationSec: 180, iterations: 50 },
      rotation: { actions: [{ action: "arcane_shot" }] },
    }).abilities.find((a) => a.name === "Arcane Shot")!.castsPerFight;
  const spell = game.data.spells["28752"]!;
  const everyHit = { ...game, data: { ...game.data, spells: { ...game.data.spells, "28752": { ...spell, proc: { ...spell.proc!, critOnly: false } } } } };
  const naked = arcanes(game, {});
  const onCrits = arcanes(game, six);
  expect(onCrits).toBeGreaterThan(naked);
  expect(arcanes(everyHit, six)).toBeGreaterThan(onCrits);
});

test("a fight-length preset sets the length and spread, and the config's own values win", () => {
  const boss30 = game.overrides.fights["dungeon-boss-30"]!;
  expect(fightLength(game, { preset: "dungeon-boss-30", iterations: 1, seed: "x" })).toEqual({ durationSec: boss30.durationSec, durationVariancePct: boss30.durationVariancePct });
  expect(fightLength(game, { preset: "dungeon-boss-30", durationSec: 90, iterations: 1, seed: "x" }).durationSec).toBe(90);
  expect(fightLength(game, { iterations: 1, seed: "x" })).toEqual({ durationSec: 180, durationVariancePct: 0 });
  expect(() => simulate(game, { ...base, fight: { preset: "wipe", iterations: 1 } })).toThrow(/unknown preset/);
  // Auto Shot alone, so casts follow the length: about 38 sec of shots against 180.
  const shots = (preset?: string) => simulate(game, { ...base, fight: { ...(preset ? { preset } : {}), iterations: 200 } }).abilities[0]!.castsPerFight;
  expect(shots("dungeon-boss-30") / shots()).toBeCloseTo(boss30.durationSec / 180, 1);
});

test("a random suffix adds its enchants' stats to the item's slot", () => {
  const suffix = [...game.suffixes.values()].find((s) => s.name === "of Agility" && s.enchants.length === 1)!;
  const agility = game.enchants.get(suffix.enchants[0]!)!.stats.agility!;
  const ch = (suffixes: Record<string, number>) =>
    buildCharacter(game.data, game.overrides, game.items, game.enchants, SimConfig.parse({ ...base, gear: { ...base.gear!, items: { head: 252605 }, suffixes } }), game.suffixes);
  expect(ch({ head: suffix.id }).primary.agility - ch({}).primary.agility).toBe(agility);
  expect(() => ch({ neck: suffix.id })).toThrow(/no item/);
});
