// Config files. A config may start with `extends = "other.toml"` (relative to itself) and set only
// what differs. Tables merge key by key; anything else, rotation.actions included, replaces the
// parent's value.
import { dirname, relative, resolve } from "node:path";
import type { ActionConfig, Build, SimConfigInput } from "@hunter-sim/engine";

type Table = Record<string, unknown>;
const isTable = (v: unknown): v is Table => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(parent: Table, child: Table): Table {
  const out = { ...parent };
  for (const [k, v] of Object.entries(child)) out[k] = isTable(v) && isTable(out[k]) ? merge(out[k] as Table, v) : v;
  return out;
}

export async function readToml(path: string, seen: string[] = []): Promise<Table> {
  if (seen.includes(path)) throw new Error(`config: extends loops back to ${path}`);
  const { extends: parent, ...own } = Bun.TOML.parse(await Bun.file(path).text()) as Table;
  if (typeof parent !== "string") return own;
  return merge(await readToml(resolve(dirname(path), parent), [...seen, path]), own);
}

// fight.fight: a fight-length preset that replaces the config's own length and spread.
export async function loadConfig(
  path: string,
  fight: { iterations?: string | undefined; seed?: string | undefined; fight?: string | undefined } = {},
): Promise<SimConfigInput> {
  const config = (await readToml(resolve(path))) as SimConfigInput;
  config.fight = { ...config.fight };
  if (fight.iterations) config.fight.iterations = Number(fight.iterations);
  if (fight.seed) config.fight.seed = fight.seed;
  if (fight.fight) {
    const { durationSec: _, durationVariancePct: __, ...rest } = config.fight;
    config.fight = { ...rest, preset: fight.fight };
  }
  return config;
}

const tomlString = (s: string) => JSON.stringify(s);

// A variant of `parent` with a build search's result: every talent is written, the parent's
// dropped ones as 0, since tables merge key by key. petAbilities replaces the parent's pet ability
// list, which would otherwise carry over to a new family.
export function buildToml(
  parent: SimConfigInput,
  parentPath: string,
  out: string,
  build: Build,
  rotation: SimConfigInput["rotation"],
  note: string,
  petAbilities?: string[],
): string {
  const talents = { ...Object.fromEntries(Object.keys(parent.talents ?? {}).map((t) => [t, 0])), ...build.talents };
  return [
    `# ${note}`,
    `extends = ${tomlString(relative(dirname(resolve(out)), resolve(parentPath)))}`,
    `name = ${tomlString(`${parent.name ?? "unnamed"}, build search`)}`,
    `position = ${tomlString(build.style.position)}`,
    "",
    "[weave]",
    `maxAutoShotDelayMs = ${build.style.weaveDelayMs}`,
    "",
    "[talents]",
    ...Object.entries(talents).map(([t, r]) => `${tomlString(t)} = ${r}`),
    "",
    "[pet]",
    `active = ${build.pet !== null}`,
    ...(build.pet ? [`family = ${tomlString(build.pet)}`] : []),
    ...(build.pet && petAbilities ? [`abilities = [${petAbilities.map(tomlString).join(", ")}]`] : []),

    "",
    "[rotation]",
    `precombat = [${(rotation.precombat ?? []).map(tomlString).join(", ")}]`,
    "",
    actionsToml(rotation.actions),
    "",
  ].join("\n");
}

export function actionsToml(actions: ActionConfig[]): string {
  return actions
    .map((a) =>
      [
        "[[rotation.actions]]",
        `action = ${tomlString(a.action)}`,
        ...(a.if ? [`if = ${tomlString(a.if)}`] : []),
        ...(a.pet ? [`pet = ${tomlString(a.pet)}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
}
