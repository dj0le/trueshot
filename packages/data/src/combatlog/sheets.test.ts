import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestSheets, openStore, parseSavedVariables, parseTime, pressesIn, readPresses, readSheets, sheetsAt } from "../index";

// What the addon saved under a stubbed WoW API (a login, then Rapid Fire), in WoW's own format.
const SAVED = `TrueshotDB = {
["sessions"] = {
{
["rows"] = {
"t=0;level=34;rap=320;ap=200;rspeed=2.800;rmin=50.500;rmax=80.250;rpct=1;rcrit=8.123;mcrit=7;hit=2;str=51;agi=52;sta=53;int=54;spi=55;armor=950;buffs=13165;gear=18:2825:0:-17;talents=000/500/000;pet=Cat;petlevel=34;petap=200;petspeed=2.0;petmin=30;petmax=40;petbuffs=", -- [1]
"t=499;level=34;rap=420;ap=200;rspeed=2.800;rmin=50.500;rmax=80.250;rpct=1;rcrit=8.123;mcrit=7;hit=2;str=51;agi=52;sta=53;int=54;spi=55;armor=950;buffs=3045,13165;gear=18:2825:0:-17;talents=000/500/000;pet=Cat;petlevel=34;petap=200;petspeed=2.0;petmin=30;petmax=40;petbuffs=", -- [2]
},
["presses"] = {
"1200;3;spell;3044;1;Arcane Shot", -- [1]
"1900;7;macro;19434;1;Aimed; then pet", -- [2]
},
["wall"] = "10/29/2026 18:30:01",
["guid"] = "Player-4613-006F26BB",
["realm"] = "Forever",
["name"] = "Arc",
["gt"] = 101.00100000000478,
}, -- [1]
},
["autolog"] = true,
}
`;

test("SavedVariables tables read as objects and lists", () => {
  expect(parseSavedVariables('A = {\n["x"] = "a\\"b\\\\", -- c\n["n"] = -1.5e2,\n{\n1, -- [1]\ntrue, -- [2]\n}, -- [1]\n}\nB = nil\n')).toEqual({
    A: { "1": [1, true], x: 'a"b\\', n: -150 },
    B: null,
  });
});

test("the recorder's rows become sheets on the combat log's clock", () => {
  const [first, second] = readSheets(SAVED);
  const anchor = parseTime("10/29/2026 18:30:01.000");
  expect(first).toMatchObject({ guid: "Player-4613-006F26BB", ts: anchor, level: 34, rap: 320, rangedSpeed: 2.8, rangedCritPct: 8.123, buffs: [13165] });
  expect(first!.gear).toEqual(["18:2825:0:-17"]);
  expect(first!.pet).toEqual({ family: "Cat", level: 34, ap: 200, speed: 2, min: 30, max: 40 });
  expect(second).toMatchObject({ ts: anchor + 499, rap: 420, buffs: [3045, 13165] });
});

test("the recorder's button presses come back with their spell, on the same clock", () => {
  const anchor = parseTime("10/29/2026 18:30:01.000");
  expect(readPresses(SAVED)).toEqual([
    { guid: "Player-4613-006F26BB", ts: anchor + 1200, slot: 3, kind: "spell", spellId: 3044, name: "Arcane Shot", combat: true },
    { guid: "Player-4613-006F26BB", ts: anchor + 1900, slot: 7, kind: "macro", spellId: 19434, name: "Aimed; then pet", combat: true },
  ]);
});

test("sheets are stored once and looked up as they stood at a time", async () => {
  const db = openStore(":memory:");
  const path = join(mkdtempSync(join(tmpdir(), "trueshot-")), "Trueshot.lua");
  writeFileSync(path, SAVED);
  expect(await ingestSheets(db, path)).toEqual({ sheets: 2, presses: 2 });
  expect(await ingestSheets(db, path)).toEqual({ sheets: 0, presses: 0 });
  const at = sheetsAt(db);
  const anchor = parseTime("10/29/2026 18:30:01.000");
  const guid = "Player-4613-006F26BB";
  expect(at(guid, anchor - 1)).toBeUndefined();
  expect(at(guid, anchor + 498)?.rap).toBe(320);
  expect(at(guid, anchor + 499)?.rap).toBe(420);
  // Hours later the addon was not running: no sheet.
  expect(at(guid, anchor + 4 * 3600_000)).toBeUndefined();
  expect(pressesIn(db, guid, anchor + 1500).map((p) => p.name)).toEqual(["Aimed; then pet"]);
});
