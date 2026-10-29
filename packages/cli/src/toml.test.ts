import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Build, SimConfigInput } from "@trueshot/engine";
import { buildToml, loadConfig } from "./toml";

test("a build search's --out file extends its parent and reads back as the found config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trueshot-"));
  const parentPath = join(dir, "parent.toml");
  await Bun.write(
    parentPath,
    [
      'name = "parent"',
      'race = "Orc"',
      "[gear.rangedWeapon]",
      "min = 61",
      "max = 114",
      "speed = 2.8",
      "[talents]",
      '"Lethal Attacks" = 5',
      '"Endurance Training" = 5',
      "[pet]",
      "active = true",
      'family = "Cat"',
      "[[rotation.actions]]",
      'action = "arcane_shot"',
    ].join("\n"),
  );
  const parent = await loadConfig(parentPath);
  const build: Build = {
    talents: { "Lethal Attacks": 5, "Improved Tracking": 3 },
    pet: "Wolf",
    style: { position: "weave", weaveDelayMs: 900 },
  };
  const rotation: SimConfigInput["rotation"] = {
    precombat: ["trueshot_aura"],
    actions: [
      { action: "intimidation", pet: "bite" },
      { action: "aimed_shot", if: 'buff.rapid_fire.up = 0 & "quoted"' },
      { action: "arcane_shot" },
    ],
  };
  const out = join(dir, "sub", "best.toml");
  await Bun.write(out, buildToml(parent, parentPath, out, build, rotation, "note"));

  const back = await loadConfig(out);
  // The parent's dropped talent is written as 0, so the merge does not bring it back.
  expect(back.talents).toEqual({ "Lethal Attacks": 5, "Endurance Training": 0, "Improved Tracking": 3 });
  expect(back.gear).toEqual(parent.gear);
  expect(back.position).toBe("weave");
  expect(back.weave).toEqual({ maxAutoShotDelayMs: 900 });
  expect(back.pet).toEqual({ active: true, family: "Wolf" });
  expect(back.rotation).toEqual(rotation);
  expect(back.name).toBe("parent, build search");
});

test("a new family's ability list replaces the parent's in a build search's --out file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trueshot-"));
  const parentPath = join(dir, "parent.toml");
  await Bun.write(parentPath, ['race = "Orc"', "[pet]", "active = true", 'family = "Cat"', 'abilities = ["claw"]'].join("\n"));
  const parent = await loadConfig(parentPath);
  const build: Build = { talents: {}, pet: "Wolf", style: { position: "ranged", weaveDelayMs: 0 } };
  const out = join(dir, "best.toml");
  await Bun.write(out, buildToml(parent, parentPath, out, build, { actions: [] }, "note", ["bite"]));
  expect((await loadConfig(out)).pet).toEqual({ active: true, family: "Wolf", abilities: ["bite"] });
});
