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
| 16 | Talent optimizer and pet sweep: rank talent builds and pet families for a given gear set. Talents follow their tooltip text where the client data is bugged, so audit each talent against its description first and override the bugged ones | packages/engine/src/talents.ts, packages/cli | DONE. `sim build` searches talents, pet and rotation together (rotation, then talents and pet from seeds and hill climbing, then rotation again); `sim pets` ranks every family on one build. Audit fixes: Improved Tracking through the Track spells (target.creatureType), hawks share only the "pets and hawks" passives (no Bestial Wrath), the dive gets Unleashed Fury and Ferocity, Efficiency skips Summon Hawk; pets autocast every damage ability and their magic attacks use spell hit. The melee talents (Strider Kick, Counterattack, Predator's Edge, Lacerating Strikes, Expose Prey) move to task 21. Unanswered: does Ranged Weapon Specialization reach Arcane Shot, and can Quick Shots proc off special shots (both set to the tooltip reading) |
| 17 | SvelteKit front end with the engine in a web worker | packages/web | |
| 18 | Target presets: normal level 60, elite 62, boss 63 (armor, level-based miss and crit) | packages/engine/src/targets | DONE |
| 19 | Marksmanship: talents, abilities, default priority list | packages/engine/src/specs/mm | DONE |
| 20 | Beast Mastery: pet-heavy talents, Bestial Wrath, Kill Command | packages/engine/src/specs/bm | DONE. The pet autocasts greedily (the cheap ability starves the dear one: a cat uses Bite about twice a fight and Claw otherwise), which matches the game; no focus pooling, since the pet is not micromanaged. A rotation action can send a pet ability from the same macro (`pet = "bite"`). Summon Hawk works with guessed hawk attack values (overrides.toml pet.hawk) |
| 21 | Survival: melee weapon, melee attack table, Raptor Strike and Mongoose Bite | packages/engine/src/sim.ts | DONE. `position = "melee"`: main and off-hand white swings (dual-wield miss, dodge, glancing), Raptor Strike on the next swing, melee abilities on melee attack power and normalized weapon damage, shots out of range. Mongoose Bite comes from Expose Prey (Hunter's Marked target only; the hunter is not tanking, so no dodges); Counterattack needs a parry and never comes up. Weapon percent effects multiply. Lacerating Strikes bleeds 40% of each bite; Predator's Edge raises crit damage and the off hand. Normalized melee speeds are TBC's (guesses) |
| 22 | Gear presets for all three specs at 60 from the GearQuestForever BiS lists | packages/data/presets | DONE, set bonuses and enchants are task 26 |
| 23 | Level-aware sim: any level 10 to 60, spell ranks and target stats by level, so level 30 beta logs can check the mechanics | packages/engine | DONE, levels.toml holds base stats, base mana, agility per crit, pet attack power and creature armor by level (vmangos and cmangos databases); targets are a level offset and the attack table follows from the gap; items go down to level 10. Comparing with the beta fights in calibration/beta-level30.toml is still to do: Troll BM, level 30, wolf, gear unknown, so compare damage shares (pet melee vs Auto Shot, hawk) rather than DPS; Jargba is level 30 with 1004 armor |
| 24 | Recalibrate against real level 60 logs after launch | tests/golden | BLOCKED, needs level 60 logs, launch is 2026-11-04 |
| 25 | Forever Logs API client: list reports, pull hunter encounter events into a local gitignored cache | packages/data/src/foreverlogs | BLOCKED, key is in .env but needs events:read, granted by hand on request |
| 26 | Set bonuses and enchants on gear | packages/data/src/build-items.ts | DONE. Sets come from Forever's ItemSet table (it reworks Beaststalker: 3pc +30 attack power, 4pc root escape, 5pc 5% chance on auto attacks for 200 mana, 6pc 8 mp5) and turn on as passives by pieces worn; `gear.enchants` takes SpellItemEnchantment ids (`sim enchants <text>` finds them), stat and scope enchants only, procs are task 27. Dragonstalker 8pc Expose Weakness uses the client's 100% proc chance; the tooltip says "a chance" and no source gives the real rate |
| 27 | Item chance-on-hit procs | packages/engine | DONE, with on-use items. Worn on-use items (trinkets) are off-GCD actions named after the item, with their own cooldown and the 20 sec lockout their category shares; the rotation and build searches may add them. Equip spells that are not plain stats run as passives (proc auras, stacking buffs, armor penetration, attack power against a creature type). Ranged weapon procs (Dark Iron Rifle) fire at formula.weaponProcPpm, a guess; Badge of the Swarmguard's rate is a guess too. Forever reworked Devilsaur Eye into a root; Mark of the Champion and the new Blackhand's Breadth on-use have no client effects, so they do nothing in the sim. Melee weapon procs wait for task 21 |
| 28 | Support presets (solo, party, raid) so rotations can be compared with and without outside mana: Blessing of Wisdom, Mana Spring, Judgement of Wisdom from the Forever client; Major Mana Potion and Demonic/Dark Rune as off-GCD rotation actions on their item cooldowns | packages/engine | DONE, party and raid presets are guesses at who is in the group; MythicSim party buffs still to match |
| 29 | Melee weaving: step in for Raptor Strike between Auto Shots, which MythicSim does for all three specs | packages/engine | DONE. `position = "weave"` walks in after an Auto Shot when the main-hand swing is ready on arrival and the walk back delays the next Auto Shot by at most weave.maxAutoShotDelayMs; one swing (Raptor Strike if queued), melee abilities while there, then back out, Auto Shot restarting a reaction later. Distances and run speed from wowsims/forever PR 575 (12 yd to 4.99 yd at 7 yd/sec, highest speed bonus counts). The build search tries ranged, melee and weaving at 0.3-2 sec delays |
| 30 | Rotation comparison: variant configs that `extends` a base, `sim compare` with several variants and a per-ability diff, `sim value` for what each action is worth | packages/cli | DONE |
| 31 | Fight-length presets: level 30 dungeon trash and bosses (mostly under 60 sec on Forever Logs), level 60 dungeon, raid boss | configs | |
| 32 | Procs that need a crit (Resourcefulness): fire only on critical strikes | packages/engine | |
| 33 | Forever food and campfire buffs (Well Fed agility/attack power foods, campfire tiers, Camp Benefits) as support options; several food spells carry placeholder values of 1 and campfire effects are server-side, so values need a source | packages/data, packages/engine | |
| 34 | GearQuest Forever importer: read the addon's hunter picks (per spec, faction, level band, ranked, levels 10-60) from the local install into gear presets by tier (best, good, average), so any level can be simmed with realistic gear | packages/data | |
| 35 | Estimate vs actual: sim my character's real gear and talents next to a log of the same boss, and the tier presets, to split the gap into execution and gear | packages/cli | BLOCKED, needs task 25 or 13 for my logs, and task 23 below level 60 |
| 36 | Racials: Skyborne Wind Blessed (+3% haste, from the talentsforever racials list), Troll Berserking, Orc Blood Fury and pet bonus, Dwarf and Troll weapon skills; plus a haste stat in gear and buffs | packages/engine | DONE, damage racials from the client (passives always on, Blood Fury, Berserking and Elune's Light as actions) and a hastePct stat. Forever has no Orc pet bonus or weapon skill racials. Skyborne base stats are still copied from Human |
| 37 | items.json carries Season of Discovery items (ids 23xxxx, item level 80+, many with +% haste) because they sit in Forever's Item table; check which really exist in Forever and drop the rest | DONE, 3,274 SoD items and the client's test items dropped; no +% haste gear is left in Forever's data |
| 38 | Audit leftovers from b983b01..HEAD: hawk dive (HAWK_DIVE) and ON_LAND scripts keyed by spell name, Renataki's Refocus keyed by item name because on-use spells take the item's name; Expose Prey's Hunter's Mark condition (PROC_IF) and Focused Fire as name lookups instead of overrides keyed by spell id; `sim build --out` keeps the parent's pet.abilities when the family changes; Item.equipSpells is read by nothing, and an equip spell with one unknown effect has its known stats counted twice (only Runeblade of Baron Rivendare today, harmless); proc internal cooldowns have no test, since no item in the data has one that shows in results | packages/engine, packages/data, packages/cli | |

Tasks 1 to 10, 18 and 19 give a working "run my setup" CLI for Marksmanship. Task 20 follows because
pets carry the weakest data. Task 21 comes last because it needs a whole melee model.

## Decisions

- Level 60 only. Three target presets instead of specific raid bosses.
- Marksmanship first. It leans on the pet least, and pet numbers are the least known.
- BM rotations do not cast Intimidation in boss fights. It is taken only to reach Bestial Wrath; even
  as a one-off opener with Bite it loses DPS.
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
- Lacerating Strikes refreshes the way Deep Wounds does: a bite on a live bleed adds the unticked
  damage to the new one, spreads the sum over a full set of ticks and keeps the old tick timer
  (wowsims/forever talents_survival.go). No Forever source says, so in-game testing is required.
- Weaving stays in melee to finish a cast or channel started there, and waits out the GCD once for a
  reactive ability (Mongoose Bite opened by the swing). Other melee abilities wait for the next weave:
  waiting for every GCD stalls Auto Shot (sv.build lost 37 DPS that way).
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
- Race matters by about 2.5% (3000 fights, both specs, solo): Skyborne 262, Night Elf and Human 261-262,
  Orc 260, Troll 259, Dwarf 257, Tauren 256-257. Skyborne's lead rests on base stats copied from Human.
- Intimidation on cooldown costs bm-cat 1.5% DPS: 138 mana and a GCD a minute in a mana-bound build,
  for one guaranteed pet crit, while Frenzy 5/5 already procs off the pet's ~18% crit rate. As a
  one-off opener macro with Bite it costs 0.2% (bm-cat.with-intimidation.toml).
- BM beats MM Lone Wolf by 4.3% in boss fights with the pet attacking all fight (optimized rotations,
  255.1 vs 244.5 DPS over 180 sec), after task 23's crit suppression and pet damage and the talent
  tooltip fixes. Break-even is the pet attacking about 85% of the fight; below that MM wins
  (`pet.attackingPct`). Before task 23 MM led by 0.3%.
- The build search (task 16) beats both hand-made builds: BM 31/16/4 with a Wind Serpent at 274.4 DPS
  (+7.6% over bm-cat.optimized) and MM 8/38/5 with a Wind Serpent at 269.3 (+10.1% over
  mm-lone-wolf.optimized), configs/bm.build.toml and configs/mm.build.toml. Both take Improved
  Tracking and Trueshot Aura; MM drops Lone Wolf for a pet. These assume the pet attacks all fight.
- Current best builds on the shared MythicSim gear (5000 fresh fights; configs/*.build.toml): SV
  34/10/7 weaving with fire traps 323.6 DPS, BM 31/17/3 ranged 276.2, MM 39/7/5 ranged 271.7, all with
  a Wind Serpent. BM and MM are kept ranged on purpose: weaving adds about 2% to them on the same build
  and about 7% after re-tuning around it, but that rests on the uncalibrated movement model (1 sec
  legs, a boss standing still), and players do not weave on those specs.
- Immolation Trap is Survival's biggest gain: 15% of its damage, placed on 9 of its 40 weaves
  (Survivalist's Discipline: 18 sec cooldown; Clever Traps; Survival Tactics against the 17% spell
  miss). It rests on two guesses from wowsims/forever: 0.5 sec arming and a 5 yd trigger reach from
  where the hunter stands mid-weave. Explosive Trap loses to it on one target.
- Survival in melee does 239.0 DPS after the build search (SV 31 / MM 13 / BM 7, Wind Serpent,
  configs/sv.build.toml), against 276.7 for BM and 271.8 for MM on the same gear. That gear is
  MythicSim's ranged set with Barbarous Blade as the only melee weapon, so melee gear could close
  some of the gap. The search spams Wing Clip as filler: 75 casts a fight for 15 DPS, and each hit
  is another 10% roll for Expose Prey's Mongoose Bite.
- Wind Serpent leads every pet sweep by about 2% (Lightning Breath is nature damage, so armor does
  not touch it), then Raptor, Cat and Bird of Prey within 1%. It rests on pet abilities not scaling
  with attack power and on no partial resists, both unverified.
- MM with a pet instead of Lone Wolf (+20% damage without a pet) gains 1.2% when the pet attacks all
  fight; Lone Wolf wins once the pet attacks less than about 93% of it.
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
| wowsims/forever (github.com/wowsims/forever) | A full Forever sim with hunter presets; PR 575 measured weaving (leg times, distances, best Auto Shot delay) | Reference for mechanics and a second calibration target (task 14) |

Not in client data and needing overrides: pet family damage modifiers, pet base stats, server
hotfixes. Each override records its source and whether it is guessed or measured.
