// Hunter DPS on the beta's dungeon bosses from Forever Logs' public statistics, as a calibration
// target: per dungeon and spec, the parse count and DPS percentiles, boss damage only. The key is
// FOREVERLOGS_API_KEY in .env; the statistics need no extra scope.
//
//   bun run foreverlogs
//
// Raw answers go to packages/data/foreverlogs-cache/ (gitignored: the terms forbid bulk
// redistribution); the derived numbers go to calibration/foreverlogs-beta.toml, credited.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const API = "https://foreverlogs.gg/api/public/v1";
const CACHE = join(import.meta.dir, "..", "foreverlogs-cache");
const OUT = join(import.meta.dir, "..", "calibration", "foreverlogs-beta.toml");
const PHASE = 1; // Beta
// The free tier allows 30 requests a minute.
const PAUSE_MS = 2100;

type SpecStats = { avg: number; median: number; max: number; min: number; total_parses: number; percentiles: Record<string, number> };
type Statistics = { statistics: Record<string, { specs: Record<string, SpecStats> }>; bosses: { boss_id: number; boss_name: string; total_kills: number }[] };
type Boss = { id: number; name: string; location: string; boss_id: number; instance_type: string };

const key = process.env.FOREVERLOGS_API_KEY;
if (!key) throw new Error("FOREVERLOGS_API_KEY is not set (.env)");

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  const body = (await res.json()) as T & { success: boolean; message?: string };
  if (!res.ok || !body.success) throw new Error(`${url}: ${res.status} ${body.message ?? ""}`);
  await Bun.sleep(PAUSE_MS);
  return body;
}

const toml = (s: string) => JSON.stringify(s);

await mkdir(CACHE, { recursive: true });
const { bosses } = await get<{ bosses: Boss[] }>("/bosses");
const dungeons = [...new Set(bosses.filter((b) => b.instance_type === "dungeon").map((b) => b.location))].sort();

const lines = [
  "# Hunter DPS on beta dungeon bosses, from Forever Logs (https://foreverlogs.gg), phase 1 (Beta),",
  "# boss damage only, all difficulties. Written by `bun run foreverlogs`; do not edit by hand.",
  "# Parses carry no level or gear: the beta capped at 30, but low dungeons were also run below it.",
  `# Fetched ${new Date().toISOString().slice(0, 10)}.`,
  "",
];
for (const location of dungeons) {
  const stats = await get<Statistics>("/statistics", { phase: String(PHASE), difficulty: "all", location, damageMode: "boss-only", class: "Hunter" });
  await Bun.write(join(CACHE, `statistics-${location.replace(/\W+/g, "-")}.json`), JSON.stringify(stats, null, 2));
  const specs = stats.statistics.Hunter?.specs ?? {};
  if (Object.keys(specs).length === 0) continue;
  lines.push("[[dungeon]]", `name = ${toml(location)}`);
  lines.push(`bosses = [${stats.bosses.map((b) => `{ name = ${toml(b.boss_name)}, id = ${b.boss_id}, kills = ${b.total_kills} }`).join(", ")}]`);
  for (const [spec, s] of Object.entries(specs)) {
    const p = s.percentiles;
    lines.push(
      `[dungeon.hunter.${toml(spec)}]`,
      `parses = ${s.total_parses}`,
      `min = ${s.min}`,
      `p25 = ${p.p25}`,
      `median = ${s.median}`,
      `p75 = ${p.p75}`,
      `p90 = ${p.p90}`,
      `max = ${s.max}`,
    );
  }
  lines.push("");
  console.log(`${location}: ${Object.entries(specs).map(([spec, s]) => `${spec} ${s.total_parses}`).join(", ")}`);
}
await Bun.write(OUT, lines.join("\n"));
console.log(`wrote ${OUT}`);
