import { expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest, openStore } from "../index";

// Lines from a public beta log (gist.github.com/ArcSim/9ef18a6ea02db6588e213b6225201225), names
// shortened. Arianna's Auto Shot is Arc's with the guid swapped, so the fox's owner is a hunter.
const VERSION = "10/17/2026 18:28:25.612-6  COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,1.60.1,PROJECT_ID,18";
const OWNER_SHOT =
  '10/17/2026 18:28:50.000-6  SPELL_CAST_SUCCESS,Player-4613-0104D103,"Arianna-Slice",0x511,0x80000000,Creature-0-6782-0-40800-116-000054067D,"Defias Bandit",0xa28,0x80000000,75,"Auto Shot",0x1,Player-4613-0104D103,0000000000000000,772,772,527,0,134,0,0,0,0,1065,1065,0,-9238.81,368.41,1429,2.7789,8';
const PET_SWING =
  '10/17/2026 18:28:53.062-6  SWING_DAMAGE,Pet-0-6782-0-55148-165189-0100395114,"Fox-Forever",0x1118,0x80000000,Creature-0-6782-0-40800-116-000054067D,"Defias Bandit",0xa28,0x80000000,Pet-0-6782-0-55148-165189-0100395114,Player-4613-0104D103,503,503,65,0,921,0,0,0,2,100,100,0,-9269.22,459.67,1429,2.2455,8,27,33,-1,1,0,0,0,nil,nil,nil';
const STRANGER =
  '10/17/2026 18:28:54.000-6  SPELL_AURA_APPLIED,Player-4613-00FC3B62,"Ander-Dymez",0x518,0x80000000,Player-4613-00FC3B62,"Ander-Dymez",0x518,0x80000000,71,"Defensive Stance",0x1,BUFF';
const DEBUFF =
  '10/17/2026 18:28:55.000-6  SPELL_AURA_APPLIED,Player-4613-00FC3B62,"Ander-Dymez",0x518,0x80000000,Creature-0-6782-0-40800-116-000054067D,"Defias Bandit",0xa28,0x80000000,7386,"Sunder Armor",0x1,DEBUFF';
const LATER_SWING = PET_SWING.replace("18:28:53.062", "18:29:20.000");

function tempLog(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "trueshot-")), "WoWCombatLog.txt");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

test("ingest keeps hunters, their pets and creature debuffs, once, and reads only what is new", async () => {
  const db = openStore(":memory:");
  const path = tempLog([VERSION, OWNER_SHOT, PET_SWING, STRANGER, DEBUFF]);
  expect(await ingest(db, path)).toMatchObject({ lines: 5, kept: 3, hunters: 1, fights: 1 });
  expect(db.query("SELECT name, kind, owner FROM units ORDER BY kind").all()).toEqual([
    { name: "Arianna", kind: "hunter", owner: "" },
    { name: "Fox", kind: "pet", owner: "Player-4613-0104D103" },
  ]);
  expect(db.query("SELECT event, st_level, amount, unmitigated, rest FROM events ORDER BY ts").all()).toEqual([
    { event: "SPELL_CAST_SUCCESS", st_level: 8, amount: null, unmitigated: null, rest: null },
    { event: "SWING_DAMAGE", st_level: 8, amount: 27, unmitigated: 33, rest: null },
    { event: "SPELL_AURA_APPLIED", st_level: null, amount: null, unmitigated: null, rest: "DEBUFF" },
  ]);
  expect(db.query("SELECT build, advanced FROM files").get()).toEqual({ build: "1.60.1", advanced: 1 });

  expect(await ingest(db, path)).toMatchObject({ bytes: 0, kept: 0 });

  // The log grows: only the new line is read, and a swing 27 sec later is a second fight.
  appendFileSync(path, `${LATER_SWING}\n`);
  expect(await ingest(db, path)).toMatchObject({ lines: 1, kept: 1, fights: 2 });
  expect(db.query("SELECT label, damage, hits FROM fights ORDER BY start_ts").all()).toEqual([
    { label: "Defias Bandit", damage: 27, hits: 1 },
    { label: "Defias Bandit", damage: 27, hits: 1 },
  ]);

  // The same lines in another file (a copied log) add nothing.
  expect(await ingest(db, tempLog([OWNER_SHOT, PET_SWING]))).toMatchObject({ kept: 0 });
});

test("an encounter is one fight, whatever the gaps inside it", async () => {
  const db = openStore(":memory:");
  const start = '10/17/2026 18:28:52.000-6  ENCOUNTER_START,1144,"Hogger",1,5,0';
  const end = '10/17/2026 18:29:30.000-6  ENCOUNTER_END,1144,"Hogger",1,5,1,38000';
  await ingest(db, tempLog([OWNER_SHOT, start, PET_SWING, LATER_SWING, end]));
  expect(db.query("SELECT name, success FROM encounters").all()).toEqual([{ name: "Hogger", success: 1 }]);
  expect(db.query("SELECT label, hits FROM fights").all()).toEqual([{ label: "Hogger", hits: 2 }]);
});
