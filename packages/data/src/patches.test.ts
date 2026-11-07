import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOverrides } from "./overrides";
import { currentPatch, findPatch, loadPatches, patchAt, patchAtUtc } from "./patches";

const temp = (text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "patches-")), "patches.toml");
  writeFileSync(path, text);
  return path;
};

test("patches.toml loads in order, and the current patch is the last", async () => {
  const patches = await loadPatches();
  expect(patches.map((p) => p.id).slice(0, 3)).toEqual(["beta", "launch", "2026-11-07"]);
  expect(currentPatch(patches).id).toBe(patches.at(-1)!.id);
  expect(() => findPatch(patches, "nope")).toThrow(/no patch "nope"/);
});

test("a log line's patch comes from its stamp and its file's offset from UTC", async () => {
  const patches = await loadPatches();
  // 2026-11-07 patch starts 08:37:36 UTC. A CET log (+60) at 09:37:40 local is 08:37:40 UTC.
  const local = Date.UTC(2026, 10, 7, 9, 37, 40);
  expect(patchAt(patches, local, 60).id).toBe("2026-11-07");
  // The same wall clock in a US Eastern log (-300) is 14:37 UTC, also after.
  expect(patchAt(patches, local, -300).id).toBe("2026-11-07");
  // Last night's CET log line at 00:25 local is 23:25 UTC the day before: launch.
  expect(patchAt(patches, Date.UTC(2026, 10, 7, 0, 25), 60).id).toBe("launch");
  // A US Pacific log (-480) at 01:00 local on the 7th is 09:00 UTC: already patched.
  expect(patchAt(patches, Date.UTC(2026, 10, 7, 1, 0), -480).id).toBe("2026-11-07");
  // Before the first patch counts as the first.
  expect(patchAtUtc(patches, 0).id).toBe("beta");
});

test("patches must be in order with unique ids", async () => {
  const p = (id: string, start: string) => `[[patch]]\nid = "${id}"\nstart = "${start}"\nsummary = "x"\n`;
  await expect(loadPatches(temp(p("a", "2026-11-02T00:00:00Z") + p("b", "2026-11-01T00:00:00Z")))).rejects.toThrow(/starts before/);
  await expect(loadPatches(temp(p("a", "2026-11-01T00:00:00Z") + p("a", "2026-11-02T00:00:00Z")))).rejects.toThrow(/twice/);
});

test("every override's patch is in patches.toml", async () => {
  const ids = new Set((await loadPatches()).map((p) => p.id));
  const o = await loadOverrides();
  for (const h of [...o.hotfix, ...o.talentHotfix]) if (h.patch !== undefined) expect(ids).toContain(h.patch);
});
