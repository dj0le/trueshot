import { expect, test } from "bun:test";
import { actors, hitsBy, hunters, parseLine, parseLog, splitFields } from "../index";

// Lines from a public beta log (gist.github.com/ArcSim/9ef18a6ea02db6588e213b6225201225), names shortened.
const PET_SWING =
  '10/17/2026 18:28:53.062-6  SWING_DAMAGE,Pet-0-6782-0-55148-165189-0100395114,"Fox-Forever",0x1118,0x80000000,Creature-0-6782-0-40800-116-000054067D,"Defias Bandit",0xa28,0x80000000,Pet-0-6782-0-55148-165189-0100395114,Player-4613-0104D103,503,503,65,0,921,0,0,0,2,100,100,0,-9269.22,459.67,1429,2.2455,8,27,33,-1,1,0,0,0,nil,nil,nil';
const STING_CRIT =
  '10/17/2026 18:29:07.904-6  SPELL_PERIODIC_DAMAGE,Player-4613-006F26BB,"Arc-Slice",0x511,0x80000000,Creature-0-6782-0-40800-525-0000540F3C,"Mangy Wolf",0x10a48,0x80000000,13551,"Serpent Sting",0x8,Creature-0-6782-0-40800-525-0000540F3C,0000000000000000,39,120,16,0,180,0,0,0,1,0,0,0,-9236.10,371.22,1429,0.6397,6,54,27,-1,8,0,0,0,1,nil,nil,ST';
const AUTO_SHOT =
  '10/17/2026 18:34:47.934-6  RANGE_DAMAGE,Player-4613-006F26BB,"Arc-Slice",0x518,0x80000000,Creature-0-6782-0-40800-525-0000541226,"Mangy Wolf",0xa48,0x80000000,75,"Auto Shot",0x1,Creature-0-6782-0-40800-525-0000541226,0000000000000000,51,120,16,0,180,0,0,0,1,0,0,0,-9334.70,270.12,1429,0.4643,6,69,74,-1,1,0,0,0,nil,nil,nil,ST';
const MISS =
  '10/17/2026 18:34:49.000-6  SWING_MISSED,Pet-0-6782-0-55148-165189-0100395114,"Fox-Roshi",0x1118,0x80000000,Creature-0-6782-0-40800-116-000054067D,"Defias Bandit",0xa28,0x80000000,DODGE,nil';

test("fields split on commas outside quotes and brackets", () => {
  expect(splitFields('A,"b, c",(1,2,[3,4]),d')).toEqual(["A", "b, c", "(1,2,[3,4])", "d"]);
});

test("a pet swing carries its owner, level and attack power", () => {
  const e = parseLine(PET_SWING)!;
  expect(e.event).toBe("SWING_DAMAGE");
  expect(e.source).toMatchObject({ name: "Fox-Forever" });
  expect(e.state).toMatchObject({ owner: "Player-4613-0104D103", attackPower: 65, armor: 921, powerType: 2, power: 100, level: 8 });
  expect(e.damage).toMatchObject({ amount: 27, unmitigated: 33, school: 1, critical: false });
});

test("spell damage reads its spell, and a crit flag", () => {
  const e = parseLine(STING_CRIT)!;
  expect(e.spell).toEqual({ id: 13551, name: "Serpent Sting", school: 8 });
  expect(e.damage).toMatchObject({ amount: 54, unmitigated: 27, critical: true });
});

test("a log sums each unit's abilities and finds hunters with their pets", () => {
  const events = parseLog([PET_SWING, STING_CRIT, AUTO_SHOT, MISS].join("\n"));
  expect(events[1]!.timeMs).toBe(14842);
  const all = actors(events);
  const fox = all.get("Pet-0-6782-0-55148-165189-0100395114")!;
  expect(fox).toMatchObject({ name: "Fox", owner: "Player-4613-0104D103", levels: new Set([8]) });
  expect(fox.abilities.get("Melee")).toMatchObject({ hits: 1, misses: 1, missTypes: { DODGE: 1 }, damage: 27 });
  expect(all.get("Player-4613-006F26BB")!.abilities.get("Serpent Sting")).toMatchObject({ crits: 1, ticks: 1, damage: 54 });
  expect(hunters(all, events).map((h) => h.hunter?.name ?? h.guid)).toEqual(["Arc", "Player-4613-0104D103"]);
  expect(hitsBy(events, fox.guid)).toEqual([
    { timeMs: 0, ability: "Melee", target: "Defias Bandit", amount: 27, unmitigated: 33, critical: false, glancing: false, level: 8, attackPower: 65 },
  ]);
});
