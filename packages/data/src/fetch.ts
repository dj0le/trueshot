// Downloads every upstream file into packages/data/raw/<build>/ and records a committed manifest
// (packages/data/manifest.json) so a checkout can tell exactly which upstream bytes it was built from.
// Files already on disk are kept unless --force is passed.
import { mkdir, exists, stat } from "node:fs/promises";
import { join } from "node:path";
import { CLASSIC_ERA_BUILD, CLASSIC_ERA_TABLES, DB2_TABLES, TALENTSFOREVER_HUNTER_URL, WOWF_BUILD, db2Url } from "./sources";

const force = process.argv.includes("--force");
const rawDir = join(import.meta.dir, "..", "raw", WOWF_BUILD);
const eraDir = join(import.meta.dir, "..", "raw", `classic-era-${CLASSIC_ERA_BUILD}`);

type ManifestEntry = { file: string; url: string; bytes: number; sha256: string; fetchedAt: string };

async function download(url: string, file: string, dir = rawDir): Promise<ManifestEntry> {
  const path = join(dir, file);
  if (force || !(await exists(path))) {
    const res = await fetch(url, { headers: { "User-Agent": "hunter-sim data fetcher" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    await Bun.write(path, await res.arrayBuffer());
    console.log(`fetched ${file}`);
  }
  const body = await Bun.file(path).arrayBuffer();
  return {
    file,
    url,
    bytes: body.byteLength,
    sha256: new Bun.CryptoHasher("sha256").update(body).digest("hex"),
    fetchedAt: (await stat(path)).mtime.toISOString(),
  };
}

await mkdir(rawDir, { recursive: true });
await mkdir(eraDir, { recursive: true });

const entries: ManifestEntry[] = [];
for (const table of DB2_TABLES) entries.push(await download(db2Url(table), `${table}.csv`));
entries.push(await download(TALENTSFOREVER_HUNTER_URL, "talentsforever-hunter.json"));
for (const table of CLASSIC_ERA_TABLES) {
  const entry = await download(db2Url(table, CLASSIC_ERA_BUILD), `${table}.csv`, eraDir);
  entries.push({ ...entry, file: `classic-era/${table}.csv` });
}

await Bun.write(
  join(import.meta.dir, "..", "manifest.json"),
  JSON.stringify({ build: WOWF_BUILD, files: entries }, null, 2),
);
console.log(`${entries.length} files in ${rawDir}`);
