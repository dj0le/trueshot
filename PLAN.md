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
| 13 | Combat log parser and sim vs log report | packages/data/src/combatlog | Parser DONE: `sim log <WoWCombatLog.txt> [--actor name]` lists hunters and pets with every ability, and every hit with the attacker's level and attack power (advanced logging). Tried on ArcSim's public beta log: our pet hits low at every level (docs/wowsims-evidence.md, addendum). More logs need task 25 or a Warcraft Logs API client (vanilla.warcraftlogs.com hosts Forever beta reports that wowsims PRs cite) |
| 14 | Calibration against the MythicSim reference sims | tests/golden | Waiting. The tier list (mythicsim.com/wow-forever/tier-list, 2026-10-26 snapshot) gives only totals: SV weave 0/20/31 1229, SV melee 973, MM weave 5/31/15 956, MM turret 858, BM weave 31/20/8 873, BM turret 762, on a 2 min level 63 boss with full raid buffs, consumables and dungeon gear. The gear, buffs and per-ability breakdowns sit behind the site's app, not a public page, so there is nothing to match ability by ability yet |
| 15 | Rotation optimizer: search over priority list orderings and thresholds | packages/engine/src/optimize | DONE |
| 16 | Talent optimizer and pet sweep: rank talent builds and pet families for a given gear set. Talents follow their tooltip text where the client data is bugged, so audit each talent against its description first and override the bugged ones | packages/engine/src/talents.ts, packages/cli | DONE. `sim build` searches talents, pet and rotation together (rotation, then talents and pet from seeds and hill climbing, then rotation again); `sim pets` ranks every family on one build. Audit fixes: Improved Tracking through the Track spells (target.creatureType), hawks share only the "pets and hawks" passives (no Bestial Wrath), the dive gets Unleashed Fury and Ferocity, Efficiency skips Summon Hawk; pets autocast every damage ability and their magic attacks use spell hit. The melee talents (Strider Kick, Counterattack, Predator's Edge, Lacerating Strikes, Expose Prey) move to task 21. Unanswered: does Ranged Weapon Specialization reach Arcane Shot, and can Quick Shots proc off special shots (both set to the tooltip reading) |
| 17 | SvelteKit front end with the engine in a web worker | packages/web | |
| 18 | Target presets: normal level 60, elite 62, boss 63 (armor, level-based miss and crit) | packages/engine/src/targets | DONE |
| 19 | Marksmanship: talents, abilities, default priority list | packages/engine/src/specs/mm | DONE |
| 20 | Beast Mastery: pet-heavy talents, Bestial Wrath, Kill Command | packages/engine/src/specs/bm | DONE. The pet autocasts greedily (the cheap ability starves the dear one: a cat uses Bite about twice a fight and Claw otherwise), which matches the game; no focus pooling, since the pet is not micromanaged. A rotation action can send a pet ability from the same macro (`pet = "bite"`). Summon Hawk works with guessed hawk attack values (overrides.toml pet.hawk) |
| 21 | Survival: melee weapon, melee attack table, Raptor Strike and Mongoose Bite | packages/engine/src/sim.ts | DONE. `position = "melee"`: main and off-hand white swings (dual-wield miss, dodge, glancing), Raptor Strike on the next swing, melee abilities on melee attack power and normalized weapon damage, shots out of range. Mongoose Bite comes from Expose Prey (Hunter's Marked target only; the hunter is not tanking, so no dodges); Counterattack needs a parry and never comes up. Weapon percent effects multiply. Lacerating Strikes bleeds 40% of each bite; Predator's Edge raises crit damage and the off hand. Normalized melee speeds are TBC's (guesses) |
| 22 | Gear presets for all three specs at 60 from the GearQuestForever BiS lists | packages/data/presets | DONE, set bonuses and enchants are task 26 |
| 23 | Level-aware sim: any level 10 to 60, spell ranks and target stats by level, so level 30 beta logs can check the mechanics | packages/engine | DONE, levels.toml holds base stats, base mana, agility per crit, pet attack power and creature armor by level (vmangos and cmangos databases); targets are a level offset and the attack table follows from the gap; items go down to level 10. `sim calibrate` compares a config with the beta fights in calibration/beta-level30.toml (configs/beta/bm-troll-30.toml). The talents said on stream do not fit 21 points (Frenzy needs 25), so the config keeps the pet talents that fit. Its guessed bow lands Auto Shot for 107 on a level 23 mob, as the stream showed (106-107); our wolf then hits for about 54 per 2.0 sec swing, where the stream's wolf hit for 41-61 at its 1.2 sec speed, so the real pet does about 1.6 times our pet's white damage (see the pet questions in docs/wowsims-evidence.md). Pet melee's share of damage still comes out close (26% vs 27%) because our Auto Shot share runs high |
| 24 | Recalibrate against real level 60 logs after launch | tests/golden | BLOCKED, needs level 60 logs, launch is 2026-11-04 |
| 25 | Forever Logs API client: list reports, pull hunter encounter events into a local gitignored cache | packages/data/src/foreverlogs.ts | Statistics DONE: `bun run foreverlogs` writes hunter DPS percentiles per beta dungeon and spec to calibration/foreverlogs-beta.toml, and `sim beta <config>` sims a config at each dungeon's boss level (calibration/beta-boss-levels.toml, from the ForeverDungeonJournal addon) and places it among them. Events BLOCKED: they need events:read, granted by hand on request. Warcraft Logs is out (its API needs a claimed character) |
| 26 | Set bonuses and enchants on gear | packages/data/src/build-items.ts | DONE. Sets come from Forever's ItemSet table (it reworks Beaststalker: 3pc +30 attack power, 4pc root escape, 5pc 5% chance on auto attacks for 200 mana, 6pc 8 mp5) and turn on as passives by pieces worn; `gear.enchants` takes SpellItemEnchantment ids (`sim enchants <text>` finds them), stat and scope enchants only, procs are task 27. Dragonstalker 8pc Expose Weakness uses the client's 100% proc chance; the tooltip says "a chance" and no source gives the real rate |
| 27 | Item chance-on-hit procs | packages/engine | DONE, with on-use items. Worn on-use items (trinkets) are off-GCD actions named after the item, with their own cooldown and the 20 sec lockout their category shares; the rotation and build searches may add them. Equip spells that are not plain stats run as passives (proc auras, stacking buffs, armor penetration, attack power against a creature type). Ranged weapon procs (Dark Iron Rifle) fire at formula.weaponProcPpm, a guess; Badge of the Swarmguard's rate is a guess too. Forever reworked Devilsaur Eye into a root; Mark of the Champion and the new Blackhand's Breadth on-use have no client effects, so they do nothing in the sim. Melee weapon procs wait for task 21 |
| 28 | Support presets (solo, party, raid) so rotations can be compared with and without outside mana: Blessing of Wisdom, Mana Spring, Judgement of Wisdom from the Forever client; Major Mana Potion and Demonic/Dark Rune as off-GCD rotation actions on their item cooldowns | packages/engine | DONE, party and raid presets are guesses at who is in the group; MythicSim party buffs still to match |
| 29 | Melee weaving: step in for Raptor Strike between Auto Shots, which MythicSim does for all three specs | packages/engine | DONE. `position = "weave"` walks in after an Auto Shot when the main-hand swing is ready on arrival and the walk back delays the next Auto Shot by at most weave.maxAutoShotDelayMs; one swing (Raptor Strike if queued), melee abilities while there, then back out, Auto Shot restarting a reaction later. Distances and run speed from wowsims/forever PR 575 (12 yd to 4.99 yd at 7 yd/sec, highest speed bonus counts). The build search tries ranged, melee and weaving at 0.3-2 sec delays |
| 30 | Rotation comparison: variant configs that `extends` a base, `sim compare` with several variants and a per-ability diff, `sim value` for what each action is worth | packages/cli | DONE |
| 31 | Fight-length presets: level 30 dungeon trash and bosses (mostly under 60 sec on Forever Logs), level 60 dungeon, raid boss | packages/data/overrides.toml, packages/engine/src/run.ts | DONE. `fight.preset` in a config or `--fight <preset>` on the command line: dungeon-trash-30, dungeon-boss-30 (38 sec, from the beta streams), dungeon-trash-60, dungeon-boss-60, raid-boss; the level 60 ones are guesses until launch logs. Forever Logs' public API gives no fight lengths without events:read |
| 32 | Procs that need a crit (Resourcefulness): fire only on critical strikes | packages/data/src/build.ts, packages/engine | DONE. A proc whose tooltip says "critical strikes" or "critical hits" fires on crits only (Resourcefulness, Cryptstalker 6pc Adrenaline Rush); the client carries no such flag |
| 33 | Forever food and campfire buffs (Well Fed agility/attack power foods, campfire tiers, Camp Benefits) as support options; several food spells carry placeholder values of 1 and campfire effects are server-side, so values need a source | packages/data, packages/engine | |
| 34 | GearQuest Forever importer: read the addon's hunter picks (per spec, faction, level band, ranked, levels 10-60) from the local install into gear presets by tier (best, good, average), so any level can be simmed with realistic gear | packages/data/src/gearquest.ts | DONE. `bun run gearquest [--levels 30,60] [--faction Alliance]` writes configs/gear/gearquest/<spec>-<level>-<tier>.toml to `extends` from: best, good and average are the 1st, 4th and 8th wearable pick per slot. Random-suffix items carry their suffix (`gear.suffixes`, from Classic Era's ItemRandomProperties, which Forever's client lacks); suffix picks without an id and server-only items are skipped. The addon sits in the Steam/Proton WoW install (GEARQUEST_DIR overrides) |
| 35 | Estimate vs actual: sim my character's real gear and talents next to a log of the same boss, and the tier presets, to split the gap into execution and gear | packages/cli | BLOCKED, needs task 25 or 13 for my logs, and task 23 below level 60 |
| 36 | Racials: Skyborne Wind Blessed (+3% haste, from the talentsforever racials list), Troll Berserking, Orc Blood Fury and pet bonus, Dwarf and Troll weapon skills; plus a haste stat in gear and buffs | packages/engine | DONE, damage racials from the client (passives always on, Blood Fury, Berserking and Elune's Light as actions) and a hastePct stat. Forever has no Orc pet bonus or weapon skill racials. Skyborne base stats are still copied from Human. Creature-type racials added 2026-10-26: Troll Beast Slaying and Dwarf Big Game Hunter (+5% vs beasts), Skyborne Elemental Insight (+5% vs elementals) |
| 37 | items.json carries Season of Discovery items (ids 23xxxx, item level 80+, many with +% haste) because they sit in Forever's Item table; check which really exist in Forever and drop the rest | DONE, 3,274 SoD items and the client's test items dropped; no +% haste gear is left in Forever's data |
| 38 | Audit leftovers from b983b01..HEAD: hawk dive (HAWK_DIVE) and ON_LAND scripts keyed by spell name, Renataki's Refocus keyed by item name because on-use spells take the item's name; Expose Prey's Hunter's Mark condition (PROC_IF) and Focused Fire as name lookups instead of overrides keyed by spell id; `sim build --out` keeps the parent's pet.abilities when the family changes; Item.equipSpells is read by nothing, and an equip spell with one unknown effect has its known stats counted twice (only Runeblade of Baron Rivendare today, harmless); proc internal cooldowns have no test, since no item in the data has one that shows in results | packages/engine, packages/data, packages/cli | | DONE. Scripts key on spell ids (every rank of an ability, Refocus by its spell), hawk dive by Summon Hawk's ranks, Expose Prey's condition by the talent's spell; talent passives keep their names, which are the config's keys. `sim build --out` writes the new family's default pet abilities. Item.equipSpells dropped, and an item equip spell keeps its stats only when all of its effects are stats. Proc internal cooldowns have a test, which found that procs striking the enemy did nothing: Hurricane's Frost Arrow, the bomb satchels, Darkmoon Card: Maelstrom and Heart of Wyrmthalak now deal damage, and equip procs that say "a chance" over a client chance of every hit run at formula.weaponProcPpm |
| 39 | Build search by spec: `--spec bm|mm|sv` keeps the most points in that tree (also `bun run wowsims search`) | packages/engine/src/talents.ts | DONE |
| 40 | Decide the open model differences with wowsims, from the evidence in docs/wowsims-evidence.md: Serpent Sting and Arcane Shot attack power scaling, Serpent Sting ticks critting, pet crit and hit inheritance, pet attack power source, pet base damage and focus rate, the 0.5 sec melee retry when weaving, and Curse of Recklessness's value and stacking in configs/wowsims | packages/data/overrides.toml, packages/engine | Pet DONE (2026-10-26): it swings a creature's weapon of its level (ExpectedStat, 2x creature DPS ±20% plus AP/14 x 2, own AP 4.2 x creature DPS), inherits the hunter's sheet crit, melee hit and 17/8 of it as spell hit, and 10% of the higher attack power; focus 5 a sec; no crit of its own. The stream's wolf now hits 49 per 1.2 sec swing against 41-61 seen, and the stream fights sim 129/111/112 against 129/121/150. Multi-Shot's 0.5 sec cast DONE (wowsims PR 661's beta logs; level 30 builds lose about 1 DPS, level 60 builds skip Multi-Shot). The rest WAITING on the user |
| 41 | Log ingest: watch the launch client's Logs folder (`_forever_/Logs`), split each log into encounters (ENCOUNTER_START/END for bosses, by target for trash and open world), decode COMBATANT_INFO (gear, stats, talents at each pull), keep every hit of my hunter and pet in a local SQLite cache so evidence piles up across sessions | packages/data/src/combatlog | DONE (2026-10-29): `sim ingest [logs] [--watch]` reads the new lines of each log into packages/data/logs-cache/logs.sqlite (gitignored), every hunter in the log and its pets and hawks, creature debuffs and deaths, encounters and raw COMBATANT_INFO; a line read twice is stored once. Fights are encounters, else runs of damage with no 10 sec gap. COMBATANT_INFO is kept raw until a Forever log shows its layout. Found on the beta log: a player's advanced block logs item level where creatures and pets log level, and its attack power does not move Serpent Sting ticks as ranged attack power does, so the hunter's level and RAP must come from COMBATANT_INFO or the addon (task 44) |
| 42 | Claimed vs reality: a claims registry (each claim names its source: tooltip, client data, an overrides.toml guess, wowsims) with a measurement on the cached logs, and a report of claimed, simmed and observed values with confidence intervals, sample size and a verdict. Measures attack power coefficients (fit against the logged attack power), target armor (damage before and after armor), crit multiplier, crit and miss rates by level gap, Auto Shot interval and clipping, proc rates, pet swing, damage and focus. Contradicted claims become overrides marked as measured. Other players' armor debuffs are read from aura events and filtered | packages/data, packages/cli | Started (2026-10-29): `sim claims [--hunter name]` reports periodic ticks against the client (and whether ticks crit), crit multiplier off armor, pet armor reduction (the target's live armor is in the log, debuffs included, so no aura filtering is needed), the armor constant hunter shots imply, pet swing speed, pet miss and dodge by level gap, Auto Shot interval and its 0.45 sec wind-up. On ArcSim's beta log most rows have too few samples; it repeats the sting findings (ticks crit, 27-33 a tick against the client's 22) and shows pet hits losing about 7% to armor where Classic's formula gives 17% (6 hits). Still to add once the hunter's sheet is known: attack power coefficients, crit and miss rates, Auto Shot speed against the bow, proc rates |
| 43 | Personal benchmark after the fight: sim my COMBATANT_INFO snapshot against the boss at the real fight length and split the gap to my DPS into luck (crit and proc rolls against expectation), execution (Auto Shot uptime and clipping, idle GCDs, late cooldowns, pet uptime, time out of range) and gear (against the tier presets). Supersedes task 35 | packages/cli | |
| 44 | Addon: export a snapshot of gear, talents, pet and stats to SavedVariables, turn combat logging on in instances, track execution live from the in-game combat log, and show my sim-optimal DPS per boss from the companion's data. Advisor only, addons cannot press buttons | packages/addon (Lua, Interface 16001) | Recorder DONE (2026-10-29), untested in the real client: HunterSimRecorder saves the sheet (level, ranged attack power, bow speed and damage, ranged and melee crit, hit, stats, buffs, gear, talents, pet) whenever a value changes, stamped on the combat log's clock, and turns combat logging and advanced logging on at every login and zone change (`/hsr` for status, `/hsr autolog off`). Symlinked into the launch client's AddOns. `sim ingest` reads its SavedVariables; claims use the sheets for the sting fit per RAP, hunter armor reduction, Auto Shot interval against the bow and Auto Shot crit. With Arc's screenshot RAP values the beta sting ticks fit 0.031 ± 0.003 RAP a tick, intercept 21.7 against the client's 22. Live tracker and the companion's targets still to do |
| 45 | Companion: watch the addon's SavedVariables, sim the snapshot against each boss of the instance (level, creature type, measured armor, a range of fight lengths) and write HunterSimData.lua into the addon folder for a /reload to load | packages/cli | |
| 46 | Boss profiles from logs (when the boss can be hit, add spawns, kill length) and engine support for downtime and target switching, then the rotation optimizer per boss profile. Mostly matters at level 60 | packages/engine, packages/data | |

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
- Another hunter's best wowsims/forever setup (wowsims-compare.json: 7/39/5 MM, Naxx gear, full raid
  buffs and armor debuffs, Human, Cat) runs at 739 DPS here (configs/wowsims). On his gear our sim
  agrees with him: his build beats our searched MM by 8.2%, SV weaving by 9.6% and BM by 13.6%, and
  Sniper Shot adds 5.3% in Rapid Fire or Quick Shots (4.3% on cooldown). Sniper Shot pays there
  because mana never runs short (98% left); in our pre-raid solo setup mana is the limit (4% left)
  and it adds nothing, which is why our searches dropped it. Of the gap to our ~300 DPS, armor
  debuffs are 31%, raid buffs about 9% more, and gear the rest: every build search so far answers
  the solo, pre-raid, full-armor case only.
- wowsims itself (`bun run wowsims`) gives his exact export 906 DPS against our 739. The gap is the pet
  (+90 on their side: more swings, his crit inherited), Arcane Shot (+72) and Serpent Sting (+51), where
  wowsims adds 10% and 2% a tick of ranged attack power (flagged "in-game testing required", from the
  Forever notes); our Auto Shot and Aimed Shot hit about 10% harder (not traced). Nothing changed here.
- Scored by wowsims on his gear, buffs and boss, our search finds SV 0/19/32 weaving (Auto Shot up to
  2 sec late) with a Raptor on Slower Attack III, Cobra Reflexes and Pet Aggression 5, Human, Arcane
  Shot and Multi-Shot on: 1065.9 DPS, +17.5% over his build and above wowsims' own SV Weave preset
  (1004.6). On his MM talents the best wowsims change is Sniper Shot in Rapid Fire or Quick Shots
  (+3.7%). configs/wowsims holds every step as a config and an importable export.
- Best build per spec on the MythicSim gear (`sim build --spec`, 5000 fresh fights, 2026-10-26): SV 7/10/34
  weaving 336.7 DPS; BM 31/16/4 ranged 277.3 and weaving 306.9; MM 7/39/5 ranged 271.7 and 7/37/7
  weaving 301.1; all with a Wind Serpent. Weaving adds about 11% to BM and MM, on the same
  uncalibrated movement model as before. SV's 323.6 above is now 332.8 for the same config, after
  the audit fixes in 598cd39.
- The evidence pass on the wowsims differences (docs/wowsims-evidence.md) traced our Auto Shot and
  Aimed Shot running 10% high to configs/wowsims/base.toml: it stacks Curse of Recklessness at
  Classic's 640 with Faerie Fire, where wowsims lets only one of them count and Forever's client gives
  505. A public beta log measures Serpent Sting at about 3% of ranged attack power a tick, and Arcane
  Shot well above its tooltip; Blizzard's notes say pets inherit the hunter's crit and hit. None of it
  is in the model yet (task 40).
- Level 30 against the beta (2026-10-26, after the pet change in task 40): the build search on
  GearQuest's "good" level 30 gear, in a party, finds BM 16/5/0, MM 0/16/5 and SV 0/0/21, all weaving
  with a Raptor, at 167-170 DPS against a level 31 elite (configs/level30/*.build.toml). `sim beta`
  puts that at the 90th to 100th percentile of beta hunter parses on Forever Logs in the dungeons
  near level 30; SV in Razorfen Kraul (median 158, p75 174) is the closest match. Parses carry no level
  or gear, so this only bounds the sim. The one hunter we can rebuild (the stream's Troll BM,
  configs/beta/bm-troll-30.toml) sims 129/111/112 DPS against 129/121/150 on the meter (96-111
  before the pet change).
- With the new pet, `sim build --spec` on the MythicSim gear finds the same talents as before:
  BM 31/16/4 at 358.1 DPS, MM 7/37/7 at 327.9 and SV 7/10/34 at 366.1, all weaving with a Wind Serpent
  (ranged BM 327.2, MM 298.4 on configs/*.build.toml). The pet is a third of BM's damage now.
- Race at level 60, ranged, raid buffs, 3 min boss (2026-10-26, current model): all races within about 2%,
  Human on top (Ruthless). Skyborne leads Troll by about 1% on most bosses, Troll leads by 2.3-2.9% on
  beasts (Beast Slaying), Skyborne by 4-5% on elementals (Elemental Insight). At level 30 against
  Jargba (35 sec, weaving), Night Elf leads by 3% (Elune's Light covers 43% of the fight) and haste
  costs DPS, since faster Auto Shots leave fewer weave windows. Skyborne's base stats are still Human's.
- Lone Wolf beats keeping the pet once the pet attacks less than about 84% of the fight in wowsims
  (93% here, where the pet is weaker).

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
