# Hunter DPS sim for WoW Forever

A simulation engine that plays thousands of level 60 fights from a written priority list and searches
for the talents, pet, gear and rotation that do the most damage. Every number traces back to a pinned
client build or to an override that records where it came from.

## Tasks

| # | Task | Where | State |
|---|------|-------|-------|
| 1 | Bun workspace scaffold, strict TS, test runner | repo root | DONE |
| 2 | Data fetcher: wago CSVs for a pinned `wowf` build, talentsforever hunter export, cached locally | packages/data/src/fetch.ts | DONE |
| 3 | Normalizer: hunter spells, ranks, effects, coefficients, talents, pet families into one typed JSON | packages/data/src/build | DONE |
| 4 | Overrides file with provenance (pet modifiers, base stats, hotfixes) | packages/data/overrides.toml | DONE |
| 5 | Stat model: race base stats, gear, buffs, talents into AP, crit, hit, speed | packages/engine/src/stats | DONE |
| 6 | Event-driven core: event queue, seeded RNG, GCD, cooldowns, auras, resources | packages/engine/src/core | DONE |
| 7 | Hunter ranged mechanics: auto shot timer, shots, stings, attack table, armor | packages/engine/src/hunter | DONE |
| 8 | Pet model: swing timer, focus, abilities, family modifier, AP scaling | packages/engine/src/pet | DONE |
| 9 | Priority list rotation format and interpreter | packages/engine/src/apl | DONE |
| 10 | CLI `sim run`: one config, N runs, DPS with error bars, damage breakdown | packages/cli | DONE |
| 11 | CLI `sim compare`: setups simmed on the same random rolls | packages/cli | DONE |
| 12 | Stat weights by small stat bumps per stat | packages/cli | DONE |
| 13 | Combat log parser and sim vs log report | packages/data/src/combatlog | BLOCKED, needs a Forever Logs API key with events:read (task 25) or raw logs from other hunters |
| 14 | Calibration against the MythicSim reference sims | tests/golden | |
| 15 | Rotation optimizer: search over priority list orderings and thresholds | packages/engine/src/optimize | DONE |
| 16 | Talent and pet sweep: rank every build and pet family for a given gear set | packages/cli | |
| 17 | SvelteKit front end with the engine in a web worker | packages/web | |
| 18 | Target presets: normal level 60, elite 62, boss 63 (armor, level-based miss and crit) | packages/engine/src/targets | DONE |
| 19 | Marksmanship: talents, abilities, default priority list | packages/engine/src/specs/mm | DONE |
| 20 | Beast Mastery: pet-heavy talents, Bestial Wrath, Kill Command | packages/engine/src/specs/bm | NEXT, needs Summon Hawk, Intimidation, a pet focus-pooling option |
| 21 | Survival: melee weapon, melee attack table, Raptor Strike and Mongoose Bite | packages/engine/src/specs/sv | |
| 22 | Gear presets for all three specs at 60 from the GearQuestForever BiS lists | packages/data/presets | DONE, set bonuses and enchants are task 26 |
| 23 | Level-aware sim: any level 10 to 60, spell ranks and target stats by level, so level 30 beta logs can check the mechanics | packages/engine | |
| 24 | Recalibrate against real level 60 logs after launch | tests/golden | BLOCKED, needs level 60 logs, launch is 2026-11-04 |
| 25 | Forever Logs API client: list reports, pull hunter encounter events into a local gitignored cache | packages/data/src/foreverlogs | BLOCKED, key is in .env but needs events:read, granted by hand on request |
| 26 | Set bonuses and enchants on gear | packages/data/src/build-items.ts | |
| 27 | Item chance-on-hit procs | packages/engine | |
| 28 | Raid buff and debuff presets, so results line up with MythicSim's party setup | packages/engine | |
| 29 | Melee weaving: step in for Raptor Strike between Auto Shots, which MythicSim does for all three specs | packages/engine | |

Tasks 1 to 10, 18 and 19 give a working "run my setup" CLI for Marksmanship. Task 20 follows because
pets carry the weakest data. Task 21 comes last because it needs a whole melee model.

## Decisions

- Level 60 only. Three target presets instead of specific raid bosses.
- Marksmanship first. It leans on the pet least, and pet numbers are the least known.
- Beta is over, it was capped at level 30, and there are no local combat logs. So the mechanics
  (attack table, auto shot timing, coefficients, pet damage share) are checked against level 30 beta
  logs from other hunters (tasks 13 and 23), and level 60 results rest on the client data plus the
  MythicSim reference (task 14) until launch logs exist (task 24).
- Forever Logs (foreverlogs.gg) has a public API with per-encounter combat events, documented at
  https://foreverlogs.gg/api/public/v1/openapi.json. It needs a free key with the events:read scope.
  Terms: visible attribution linking back to Forever Logs, no bulk redistribution. So raw events stay in
  a gitignored local cache, and only derived numbers (hit rates, damage shares) go in the repo, credited.
- All TypeScript on Bun. The engine is pure (no I/O), so it runs unchanged in the CLI now and in a
  SvelteKit web worker later. Rust/WASM only if the optimizer outgrows it, and then only the inner loop.

## Findings so far

These rest on the guesses listed in overrides.toml, so they are leads to check against logs, not facts.

- Mana decides Marksmanship. The naive priority list is out of mana 74% of the fight; the optimized one
  drops Arcane Shot and Multi-Shot, keeps Serpent Sting up, and only casts Aimed Shot when it fits before
  the next Auto Shot. That is +13.7% DPS (task 15). MythicSim also has Aimed Shot under 1% of damage.
- With Careful Aim 5/5, intellect is worth about as much as agility for MM (task 12).
- Serpent Sting matches the client tooltip (555 over 15 sec, no attack power scaling). MythicSim gets about
  twice our Serpent Sting DPS. Unresolved until logs exist.
- Pet family damage modifiers are in the client (each family's Tamed Pet Passive) and match Classic.
  Fox shares Wolf's passive: no damage bonus.
- Forever retuned many weapon speeds while keeping their DPS.
- About 12,000 of Forever's 32,000 items are not shipped in the client; the server sends them. Those use
  Classic Era stats and are flagged in every run.

## Data sources

| Source | Gives | Notes |
|---|---|---|
| wago.tools, product `wowf` | Raw client DB2 tables as CSV: spell effects, coefficients, cooldowns, items, pet families | Pinned in `packages/data/src/sources.ts`. Contains Classic and SoD leftover spell IDs, filter by the talentsforever spellbook |
| talentsforever.com `/export/hunter.json` | Talents, every spell rank, tooltips, races | CC BY 4.0, credit with a link |
| beastmaster.io | Forever pet list (attack speed, abilities), family damage modifiers | Modifiers are Classic values. No stated license, use as reference |
| GearQuestForever addon data | Level 60 BiS lists per spec | Classic BiS guides, not Forever-tuned |
| MythicSim tier list | Reference DPS per spec | Calibration target only |

Not in client data and needing overrides: pet family damage modifiers, pet base stats, server
hotfixes. Each override records its source and whether it is guessed or measured.
