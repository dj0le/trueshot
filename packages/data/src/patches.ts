// The game's patches (packages/data/patches.toml) and which one a combat log line belongs to.
//
// Log stamps are the writer's local wall clock with no zone, stored as if they were UTC. A file's
// offset from UTC turns them into real time: the store keeps it per file (set at ingest for other
// players' logs), else it is this machine's zone at that moment.
import { join } from "node:path";
import { z } from "zod";

const Patch = z.object({
  id: z.string().min(1),
  start: z.string().datetime(),
  window: z.string().optional(),
  build: z.string().optional(),
  notes: z.string().url().optional(),
  summary: z.string().min(1),
});
export type Patch = z.infer<typeof Patch> & { startMs: number };

export const PATCHES_PATH = join(import.meta.dir, "..", "patches.toml");

export async function loadPatches(path = PATCHES_PATH): Promise<Patch[]> {
  const raw = z.object({ patch: z.array(Patch).min(1) }).parse(Bun.TOML.parse(await Bun.file(path).text()));
  const patches = raw.patch.map((p) => ({ ...p, startMs: Date.parse(p.start) }));
  const ids = new Set<string>();
  patches.forEach((p, i) => {
    if (ids.has(p.id)) throw new Error(`patches.toml: patch "${p.id}" twice`);
    ids.add(p.id);
    if (i && p.startMs <= patches[i - 1]!.startMs) throw new Error(`patches.toml: "${p.id}" starts before "${patches[i - 1]!.id}"`);
  });
  return patches;
}

// This machine's offset from UTC, in minutes, at a log stamp (local wall clock stored as UTC).
export function localOffsetMin(logMs: number): number {
  return -new Date(logMs).getTimezoneOffset();
}

// The patch live at a real (UTC) time; before the first patch, the first.
export function patchAtUtc(patches: Patch[], utcMs: number): Patch {
  let at = patches[0]!;
  for (const p of patches) if (p.startMs <= utcMs) at = p;
  return at;
}

// The patch a log line belongs to, from its stamp and its file's offset (undefined: this machine's).
export function patchAt(patches: Patch[], logMs: number, offsetMin?: number | null): Patch {
  return patchAtUtc(patches, logMs - (offsetMin ?? localOffsetMin(logMs)) * 60_000);
}

export const currentPatch = (patches: Patch[]): Patch => patches.at(-1)!;

export function findPatch(patches: Patch[], id: string): Patch {
  const p = patches.find((x) => x.id === id);
  if (!p) throw new Error(`no patch "${id}" in patches.toml (${patches.map((x) => x.id).join(", ")})`);
  return p;
}
