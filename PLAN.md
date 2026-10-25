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
| 20 | Beast Mastery: pet-heavy talents, Bestial Wrath, Kill Command | packages/engine/src/specs/bm | NEXT, needs a pet focus-pooling option. Summon Hawk works with guessed hawk attack values (overrides.toml pet.hawk). Intimidation is taken for Bestial Wrath but not cast: casting it loses DPS, see findings |
| 21 | Survival: melee weapon, melee attack table, Raptor Strike and Mongoose Bite | packages/engine/src/specs/sv | |
| 22 | Gear presets for all three specs at 60 from the GearQuestForever BiS lists | packages/data/presets | DONE, set bonuses and enchants are task 26 |
| 23 | Level-aware sim: any level 10 to 60, spell ranks and target stats by level, so level 30 beta logs can check the mechanics | packages/engine | |
| 24 | Recalibrate against real level 60 logs after launch | tests/golden | BLOCKED, needs level 60 logs, launch is 2026-11-04 |
| 25 | Forever Logs API client: list reports, pull hunter encounter events into a local gitignored cache | packages/data/src/foreverlogs | BLOCKED, key is in .env but needs events:read, granted by hand on request |
| 26 | Set bonuses and enchants on gear | packages/data/src/build-items.ts | |
| 27 | Item chance-on-hit procs | packages/engine | |
| 28 | Support presets (solo, party, raid) so rotations can be compared with and without outside mana: Blessing of Wisdom, Mana Spring, Judgement of Wisdom from the Forever client; Major Mana Potion and Demonic/Dark Rune as off-GCD rotation actions on their item cooldowns | packages/engine | DONE, party and raid presets are guesses at who is in the group; MythicSim party buffs still to match |
| 29 | Melee weaving: step in for Raptor Strike between Auto Shots, which MythicSim does for all three specs | packages/engine | |
| 30 | Rotation comparison: variant configs that `extends` a base, `sim compare` with several variants and a per-ability diff, `sim value` for what each action is worth | packages/cli | DONE |
| 31 | Fight-length presets: level 30 dungeon trash and bosses (mostly under 60 sec on Forever Logs), level 60 dungeon, raid boss | configs | |
| 32 | Procs that need a crit (Resourcefulness): fire only on critical strikes | packages/engine | |
| 33 | Forever food and campfire buffs (Well Fed agility/attack power foods, campfire tiers, Camp Benefits) as support options; several food spells carry placeholder values of 1 and campfire effects are server-side, so values need a source | packages/data, packages/engine | |
| 34 | GearQuest Forever importer: read the addon's hunter picks (per spec, faction, level band, ranked, levels 10-60) from the local install into gear presets by tier (best, good, average), so any level can be simmed with realistic gear | packages/data | |
| 35 | Estimate vs actual: sim my character's real gear and talents next to a log of the same boss, and the tier presets, to split the gap into execution and gear | packages/cli | BLOCKED, needs task 25 or 13 for my logs, and task 23 below level 60 |
| 36 | Racials: Skyborne Wind Blessed (+3% haste, from the talentsforever racials list), Troll Berserking, Orc Blood Fury and pet bonus, Dwarf and Troll weapon skills; plus a haste stat in gear and buffs | packages/engine | |
| 37 | items.json carries Season of Discovery items (ids 23xxxx, item level 80+, many with +% haste) because they sit in Forever's Item table; check which really exist in Forever and drop the rest | packages/data/src/build-items.ts | |

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
- Conditions that turn true with time alone (`time > 30`, `buff.x.remains < 2`) are noticed within a
  100 ms reaction delay (REACTION_MS in sim.ts), not at the exact moment. The exact alternative is for
  each time-based getter to report when it next crosses its threshold and wake the fight then. We chose
  the simpler, human-like polling; revisit if a result ever depends on sub-100 ms timing.
- Auto Shot fires through Aimed Shot and Sniper Shot casts (Forever's change, Blizzard-confirmed per the
  forever-hunter wiki and a Blizzard forum thread; Robcat's Oct 16 video). Channels (Volley) still hold
  it. A beta player remembers the cast bar "hiccuping" when an Auto Shot fired mid-cast; whether that
  costs cast time is unknown, so the cast is left untouched until logs say otherwise.
- All TypeScript on Bun. The engine is pure (no I/O), so it runs unchanged in the CLI now and in a
  SvelteKit web worker later. Rust/WASM only if the optimizer outgrows it, and then only the inner loop.

## Findings so far

These rest on the guesses listed in overrides.toml, so they are leads to check against logs, not facts.

- Mana decides Marksmanship. The naive priority list is out of mana 74% of the fight; the optimized one
  drops Arcane Shot and Multi-Shot, keeps Serpent Sting up, and only casts Aimed Shot when it fits before
  the next Auto Shot. That is +13.1% DPS (task 15). MythicSim also has Aimed Shot under 1% of damage.
- Outside mana decides the "hold vs fire on cooldown" question. Solo, holding Arcane above 40% mana
  wins by 3.7%; with a paladin's Blessing of Wisdom the gap is 0.3%; in a raid, Judgement of Wisdom
  (100% per hit in the Forever client) makes mana effectively unlimited.
- 3% ranged haste (Skyborne's Wind Blessed) is worth about as much as 20 agility: +1.5% DPS for BM and
  +2.1% for MM solo, up to +2.4% for MM in a raid, where mana no longer limits the extra shots.
- Intimidation costs bm-cat 1.3% DPS: 138 mana and a GCD a minute in a mana-bound build, for one
  guaranteed pet crit, while Frenzy 5/5 already procs off the pet's ~18% crit rate.
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
