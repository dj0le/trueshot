# Trueshot

A hunter DPS sim for WoW Forever, plus a small addon that records what actually happens in game.

A lot of numbers in Forever don't match their tooltips. Trueshot sims your hunter, then checks the
sim against your own combat logs so you can see where the tooltip says one thing and the game does
another. Later on it will tell you how close each boss fight came to the best your current gear,
pet and talents can do.

It's a work in progress. The sim works; the log checks are new and need real launch data.

## What's here

- `packages/engine`: the sim. Fights are event driven, with Auto Shot, shots, stings, pets, hawks,
  melee weaving, procs, set bonuses and so on.
- `packages/cli`: the `sim` command.
- `packages/data`: game data pulled from the Forever client, plus `overrides.toml`, where every value
  that isn't in the client data is listed with where it came from.
- `packages/addon/Trueshot`: the in-game addon.
- `configs`: example setups to sim.
- `PLAN.md`: the task list, decisions and findings so far.

## Running the sim

You need [Bun](https://bun.sh).

```sh
bun install
bun run sim run configs/mm-lone-wolf.toml
```

Run `bun run sim` on its own to see every command. The useful ones:

- `sim run <config>`: DPS and a per-ability breakdown
- `sim compare <base> <variant>...`: setups simmed against each other on the same random rolls
- `sim build <config>`: searches talents, pet, play style and rotation together
- `sim weights <config>`: stat weights

Configs are TOML. Copy one from `configs/` and change it.

## The addon

The addon does four things:

- reminds you before a pull: when you target something hostile out of combat, it shows one line in
  the middle of the screen if your pet is missing, dead or unhappy, you have no Aspect (or Cheetah
  or Pack is still on), or you are low on arrows
- after each fight of 8 seconds or more, prints one line: Auto Shots fired against what your bow
  allowed, the late ones and the time they cost, the times you stopped shooting, and your casts. It
  works from timing alone, since Forever hides damage, health and mana from addons in combat
- turns combat logging (with advanced logging) on every time you log in, so you don't forget
- saves your character sheet whenever it changes: level, ranged attack power, bow speed, crit, hit,
  buffs, gear, talents and pet, plus your button presses

The combat log is missing most of that (it logs your item level instead of your level, for one), so
the sim needs it to make sense of your logs.

Combat logs grow fast: an evening of dungeons wrote about 50 MB. Delete old ones from
`_forever_/Logs` now and then, or turn the logging off with `/ts autolog off`.

Install it from CurseForge, or copy `packages/addon/Trueshot` into your
`World of Warcraft/_forever_/Interface/AddOns` folder. Commands:

- `/ts`: status
- `/ts remind`: what it would remind you of right now; `/ts remind off` and `/ts remind on`
- `/ts summary off` and `/ts summary on`: the after-fight line
- `/ts autolog off` and `/ts autolog on`: whether it turns combat logging on

## Checking the sim against your logs

After playing (log out or `/reload` first so the addon's data is saved):

```sh
bun run sim ingest
bun run sim claims --hunter YourName
```

`ingest` reads your combat logs and the addon's data into a local database in
`packages/data/logs-cache` and only reads what's new each time, so you can run it whenever you like.
`--watch` keeps it running and picks up new data every 30 seconds.

`claims` lists each thing the tooltips, client data or the sim claim, what your logs show, and
whether they agree. With only a few fights most lines will say "too few". It gets more useful the
more you play.

If your game isn't installed in the default Steam/Proton location, point it at your logs with
`FOREVER_LOGS_DIR`, or pass log files directly to `sim ingest`.

## Patches

The game changes under us, often without patch notes, and the combat log doesn't say which patch it
was written on. `packages/data/patches.toml` lists each patch with the time it went live, and every
stored fight belongs to the patch that was live at the time.

- `sim patches` lists them, with how many stored fights each one has.
- `sim claims` uses the current patch unless you pass `--patch <id>` or `--patch all`.
- `sim claims --compare <id>` puts each measurement from that patch next to the current one and marks
  what moved. This is how changes nobody announced show up.
- Logs from someone in another time zone need `sim ingest --utc-offset -05:00 <their log>`, so their
  fights land in the right patch.

When wago.tools shows a new Forever client build, `bun run diff-build <old> <new>` lists what changed
for hunters before you move the data to it.

## License

MIT
