import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest, ingestSheets, loadGameData, openStore, parseTime } from "@trueshot/data";
import { listFights, review } from "./review";

const game = await loadGameData();

// A made-up fight in the beta log's layout: Hunter's Mark, Serpent Sting, four Auto Shots on a
// 2.8 sec bow (two a little late, then a long stop while the hunter runs), a failed Arcane Shot,
// and the wolf dying with the sting still on.
const ME = "Player-4613-00000001";
const H = `${ME},"Me-Forever",0x511,0x80000000`;
const WOLF = "Creature-0-6782-0-40800-525-0000540F3C";
const W = `${WOLF},"Mangy Wolf",0x10a48,0x80000000`;
const START = "10/30/2026 20:00:00.000";
const stamp = (ms: number) => {
  const d = new Date(parseTime(START) + ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `10/30/2026 20:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}-6`;
};
const me = (power: number, x: number) => `${ME},0000000000000000,500,500,300,0,600,0,0,0,0,${power},1000,0,${x},0,1429,0,30`;
const wolf = `${WOLF},0000000000000000,300,400,0,0,180,0,0,0,1,0,0,0,10,10,1429,0,28`;
const line = (ms: number, rest: string) => `${stamp(ms)}  ${rest}`;
const LOG = [
  line(0, `SPELL_CAST_SUCCESS,${H},${W},14325,"Hunter's Mark",0x40,${me(1000, 0)}`),
  line(50, `SPELL_AURA_APPLIED,${H},${W},14325,"Hunter's Mark",0x40,DEBUFF`),
  line(1000, `SPELL_CAST_SUCCESS,${H},${W},13551,"Serpent Sting",0x8,${me(900, 0)}`),
  line(1000, `SPELL_AURA_APPLIED,${H},${W},13551,"Serpent Sting",0x8,DEBUFF`),
  ...[2000, 5000, 8000, 14000].flatMap((ms, i) => [
    line(ms, `SPELL_CAST_SUCCESS,${H},${W},75,"Auto Shot",0x1,${me(900, i < 2 ? 0 : 10)}`),
    line(ms + 300, `RANGE_DAMAGE,${H},${W},75,"Auto Shot",0x1,${me(900, i < 2 ? 0 : 10)},100,120,-1,1,0,0,0,nil,nil,nil`),
  ]),
  line(4000, `SPELL_PERIODIC_DAMAGE,${H},${W},13551,"Serpent Sting",0x8,${wolf},20,20,-1,8,0,0,0,nil,nil,nil`),
  line(9000, `SPELL_CAST_FAILED,${H},0000000000000000,nil,0x80000000,0x80000000,3044,"Arcane Shot",0x40,"Not enough mana"`),
  line(14500, `UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,${W},0`),
];
const SAVED = `TrueshotDB = {
["sessions"] = {
{
["rows"] = { "t=0;level=30;rap=300;rspeed=2.800", },
["presses"] = { "8900;3;spell;3044;1;Arcane Shot", "8950;3;spell;3044;1;Arcane Shot", "999;1;spell;14325;1;Hunter's Mark", },
["wall"] = "10/30/2026 19:59:59",
["guid"] = "${ME}",
},
},
}
`;

test("a fight review finds late and stopped Auto Shots, the sting lost to the death, uptimes and presses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trueshot-"));
  writeFileSync(join(dir, "WoWCombatLog.txt"), `${LOG.join("\n")}\n`);
  writeFileSync(join(dir, "Trueshot.lua"), SAVED);
  const db = openStore(":memory:");
  await ingest(db, join(dir, "WoWCombatLog.txt"));
  await ingestSheets(db, join(dir, "Trueshot.lua"));
  const [fight] = listFights(db, "Me");
  const r = review(game, db, fight!.id);

  // The fight runs from the first hit (the first Auto Shot lands at 2.3 sec) to the last.
  expect(r.durationSec).toBeCloseTo(12, 5);
  expect(r.target).toMatchObject({ name: "Mangy Wolf", level: 28, armor: 180 });
  expect(r.damage).toEqual({ hunter: 420, pet: 0, overkill: 0 });
  expect(r.casts.find((c) => c.name === "Auto Shot")).toMatchObject({ casts: 4, damage: 400 });
  // Mark and sting went up before the first hit, inside the lead-in.
  expect(r.casts.find((c) => c.name === "Hunter's Mark")).toMatchObject({ casts: 1, dealsDamage: false, busySec: 1.5 });
  expect(r.failures).toEqual([{ name: "Arcane Shot", reason: "Not enough mana", count: 1 }]);

  // Gaps of 3, 3 and 6 sec on a 2.8 sec bow: 0.4 sec late, and 3.2 sec off.
  expect(r.autoShot).toMatchObject({ shots: 4, speedFromSheet: true, avgDamage: 100 });
  expect(r.autoShot.speedSec).toBeCloseTo(2.8, 5);
  expect(r.autoShot.delaySec).toBeCloseTo(0.4, 5);
  expect(r.autoShot.stoppedSec).toBeCloseTo(3.2, 5);
  // The sting from 1 sec would run to 16; the wolf died at 14.5.
  expect(r.dots).toEqual([{ name: "Serpent Sting", applied: 1, ticks: 1, lostToDeathSec: 1.5, clippedSec: 0, appliedSec: 15 }]);
  expect(r.uptime.mark).toBeCloseTo(1, 5);
  expect(r.uptime.pet).toBeUndefined();
  expect(r.mana).toEqual({ startPct: 90, minPct: 90, endPct: 90 });
  // 10 yd between the shots at 5 and 8 sec (their hits at 5.3 and 8.3 are the positions).
  expect(r.movement.yards).toBeCloseTo(10, 5);
  expect(r.movement.movingSec).toBeCloseTo(10 / 7, 5);

  // Hunter's Mark cast 1 ms after its press; two Arcane Shot presses did nothing.
  expect(r.presses).toEqual([
    { name: "Arcane Shot", presses: 2, casts: 0 },
    { name: "Hunter's Mark", presses: 1, casts: 1 },
  ]);
});
