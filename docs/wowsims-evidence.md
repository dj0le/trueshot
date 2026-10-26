# Evidence pass: open differences with wowsims/forever (2026-10-26)

Setup compared: wowsims-compare.json (his 7/39/5 MM export). wowsims 906.4 DPS (3000 fights), ours
738.9 (configs/wowsims/base.toml, 2000 fights). wowsims checkout at ce4dd1a (shallow, 2026-10-26).
A one-fight wowsims debug log (simOptions.debug) gave per-hit damage stages, quoted below.

Confidence labels: high = client data or Blizzard notes or in-game measurement with a log;
medium = secondhand measurement or community guide; low/guess = inference.

---

## 5 first, because it is solved: our Auto Shot and Aimed Shot "about 10% harder"

Cause: target armor in our config, not a formula. Traced to the exact number.

- wowsims debug log, every physical hunter hit: AfterResistances / AfterAttackerMods = 331.1 / 389.8 =
  0.8494, i.e. 15.1% armor reduction. Target log lines show only Faerie Fire (-505) and Sunder
  (-2250) applied: 3731 - 2755 = 976 armor. 976 / (976 + 5500) = 15.1%.
- Ours: configs/wowsims/base.toml:75 `armorReduction = 3395` (2250 + 505 + 640 Curse of
  Recklessness), so 336 armor, 5.8% reduction (stats.ts:116-118). 0.9424 / 0.8494 = 1.110.
- Rerun of our sim with armorReduction = 2755 (base.toml with armorReduction 2755): Auto Shot avg hit 484 vs
  wowsims 489, Aimed Shot 993 vs 976, total 676.4 DPS. The remaining ~1% on Auto Shot is Gift of
  Arthas: wowsims' AfterTargetMods adds a flat +8.0 to every physical hit (his export has
  giftOfArthas, base.toml leaves it out). Aimed Shot's last +1.7% is not traced (within what crit
  rate and roll noise could do; both sims use 2.8 sec ranged normalization: wowsims
  sim/core/attack.go:82-84, ours overrides.toml:115).

Two separate questions inside this:
1. Curse of Recklessness value. Forever client SpellEffect 11717 (rank 4): aura 674, base points
   -505, not Classic's -640. Tooltip "reducing the target's armor by $s2". So 640 in base.toml is a
   Classic number and wrong for Forever. Confidence: high (client data).
2. Whether Faerie Fire and Curse of Recklessness stack. wowsims puts CoR, Faerie Fire and Dust Cloud
   in one "MinorArmorReduction" category, strongest only (sim/core/buffs/meta.go:158,
   buffs/debuffs_auto_gen.go:87 and :108), with an open TODO in sim/hunter/pets.go
   registerDustCloud: "verify in game that Curse of Recklessness, Faerie Fire and Dust Cloud share
   one slot". In Classic they stacked. The client gives no stacking hint: aura 674 is a general
   armor aura in this client (280 spells, incl. Sunder, Expose Armor, Devotion Aura, Inner Fire), and
   FF and CoR now carry the identical -505. No Forever source found either way. Confidence: unknown.

Effect on our number: 336 armor (Classic stacking, 640) -> 471 (stacking, 505) costs about 2.3% of
physical damage; 976 (no stacking) costs about 9.9%.

Recommendation: change base.toml's CoR to 505 now (client). Leave the stacking question to the user;
it is a config assumption, not an engine formula. Our armor formula, ArmorConstant (5500 at 60 in
Forever's ExpectedStat table) and boss armor (3731, ExpectedStat level 63) all agree with wowsims.

---

## 2 Arcane Shot attack power scaling

What we do: client data only. packages/data/generated/hunter.json spell 14287 effect 0: basePoints
217, apCoefficient 0 (from SpellEffect.BonusCoefficientFromAP, packages/data/src/build.ts:152); the
coefficient would be applied in packages/engine/src/sim.ts:632.

What wowsims does: sim/hunter/arcane_shot.go:9-13, `arcaneShotAPShare = 0.1` of ranged attack power,
"TODO: In-game testing required. The row states no attack power share; the Forever notes say the
shot scales with 10% of ranged attack power." Debug log: rank 8 BaseDamage 400.1 at RAP 1760 =
217 + 0.104 x 1760.

Client data: the Forever client (1.60.1.70532) carries an AP coefficient on almost nothing. In all of
SpellEffect.csv only 3 effects have nonzero BonusCoefficientFromAP (412790 Infernal Strike, 429151
Hammer of Wrath, 470265 Avenger's Shield, all Season of Discovery leftovers). Arcane Shot (all 8
ranks), Serpent Sting, traps and Summon Hawk all have 0 there and 0 in EffectBonusCoefficient.
Summon Hawk's tooltip states "plus 5% of your Ranged Attack Power" ($rap in the description) while
its effect also has 0, and Blizzard's Oct 16 notes say "The Hunter's Fire traps now correctly scale
with Attack Power" while the trap effects have 0 too. So the client columns cannot rule AP scaling in
or out: the server sets it. The Arcane Shot tooltip ("An instant shot that causes $s1 Arcane
damage") mentions no attack power, unlike the hawk's.

In-game evidence (new): the raw beta log in ArcSim's gist (linked from wowsims PR 664,
https://gist.github.com/ArcSim/9ef18a6ea02db6588e213b6225201225, 2026-10-17, build 1.60.1) has 6
Arcane Shot hits by another hunter ("Dedbeat-Dad"), spell 14283 (rank 4, tooltip 65 damage, learned
at 28) on level 5-6 Mangy Wolves: 103, 103, 103, 103, 103, 102, never a crit, constant. 65 -> 102 is
+37 to 38. Improved Arcane Shot is cooldown only in Forever (Blizzard Hunter deep dive), and even
Lone Wolf + all-school Ranged Weapon Specialization would give at most 65 x 1.26 = 82. Flat AP
scaling of about 10% at ~350-380 RAP (normal for a level 28-30 hunter) fits. His RAP is not in the
log, so this corroborates "it scales" but does not pin the coefficient. Confidence: medium-high that
Arcane Shot scales with RAP; medium that it is 10%.

Unverified: a web search returned two PR summaries from github.com/ElliotWood/Forever (#592,
#707: Arcane Shot fitted at about 0.11 of RAP, measured 0.107-0.12 on level 20-30 beta logs via
Aspect of the Hawk and Hunter's Mark swaps; Serpent Sting 0.033-0.042 a tick). Both URLs return 404
and the repo is not public now, so I could not read them. Treat as hearsay.

Recommendation: add `[[hotfix]]` apCoefficient 0.10 on Arcane Shot effect 0 for all ranks
(3044, 14281-14287), confidence "reported", citing the log and wowsims. It is +72 DPS on his setup.

---

## 3 Serpent Sting attack power scaling

What we do: 555 over 15 sec, no AP (hunter.json 25295: basePoints 111 per 3 sec tick,
apCoefficient 0). Tick formula would apply a coefficient at tick time (sim.ts:846), as wowsims does.

What wowsims does: sim/hunter/serpent_sting.go:9-11, `serpentStingTickAPShare = 0.02` a tick
(10% over the duration), "TODO: In-game testing required ... the Forever notes say 10% of ranged
attack power over the duration, 2% a tick, read at each tick." Open PR 664 (ArcSim, 2026-10-24)
changes it to 0.030 a tick from an in-game test; a maintainer (ToxicKevinFerm) answered "it seems to
be around 0.032 ... Keep it at 0.030". Not merged in our checkout.

In-game evidence (strongest of all items): https://github.com/wowsims/forever/pull/664 with the raw
log (gist above). Same hunter (Arc-Slice), same mob type, Serpent Sting 13551 (Forever rank 4,
client base 22 a tick, tooltip 110 over 15 sec), Improved Stings 0/3, character sheet screenshots
of RAP in the PR:
- naked, RAP 174: ticks 27, 27, 27, 28, 27, 27, 28, 27, 27 (one 54 crit)
- agility gear, RAP 361: ticks 33, 33, 33 (baseAmount 32 in the log)
I re-parsed the gist myself: these numbers are in it. 22 + 0.030 x 174 = 27.2, 22 + 0.030 x 361 =
32.8. The tick moved with gear within 40 seconds on one character, so it is attack power (or
agility) scaling, not level scaling. 0.02 would give 25 and 29, which the log rules out.
Confidence: high that it scales; medium-high on 0.030 a tick (two RAP points, integer rounding;
0.030-0.032 fit).

Also from PR 452 (wowsims, 10-14 group log): Serpent Sting ticks crit at the ranged crit (17/502 =
3.4% vs Auto Shot 46/1356 = 3.4%), crits x2. The PR 664 log shows a 54 = 2 x 27 crit tick too. Our
run shows Serpent Sting Crit% 0.0: check whether our ticks can crit.

MythicSim "about twice our Serpent Sting DPS": AP scaling of 0.15 RAP per sting explains part of it
(at ~1200 RAP, 555 -> ~735 before talents); I found nothing that explains a full 2x. Guess.

Recommendation: hotfix apCoefficient 0.03 on the Serpent Sting periodic effect of all Forever
ranks, confidence "confirmed" or "reported" (measured by a third party with a public log), and
check tick crits.

---

## 1 Pet strength

On his setup: wowsims pet 163 DPS (Melee 142.0, Bite 12.2, Claw 9.2) vs ours 73 (Melee 48.5, Claw
24.2, Bite 0.6). Five separate differences, largest first.

### 1a Base weapon damage (biggest)
- Ours: vmangos formula, overrides.toml:205-209 `pet.baseDamagePerLevel` L x 1.2075 to L x 1.5225 per
  2.0 sec at base AP (72-91 at 60), scaled by 0.7 + 0.3 x AP / baseAP (pet.ts:172-181). I checked
  vmangos source: Pet.cpp InitStatsForLevel ("Formulas reviewed by Clank <Nostalrius>, from vanilla
  pet tab screenshots") and StatSystem.cpp Pet::UpdateDamagePhysical: our model is exactly
  vmangos. Base AP (levels.toml:424 pet.attackPower, 2 x str - 20) also matches vmangos.
- wowsims: sim/hunter/pets.go:32-54. Swing = 2 x creature auto attack DPS (Forever client
  ExpectedStat.CreatureAutoAttackDps) +-20%, plus AP/14 x 2.0; own AP = 0.3 x 14 x creature DPS.
  At 60: 96.7-145.1 per 2.0 sec before AP, own AP 253.9.
- wowsims' cited evidence (pets.go:32-49): pet sheets read in the Forever beta: level 11 Carrion
  Bird 20-27 damage at 44 AP, 2.0 sec; level 17 Cat 28-37 and 27-37 at 75 and 72 AP, 1.5 sec with
  Faster Attack III; own AP 36, 61 and 103 at levels 11, 17, 30. No link to the screenshots is
  given. I pulled ExpectedStat from wago.tools (build 1.60.1.70532) and checked: floor(4.2 x
  creature DPS) is 36, 61, 103 at levels 11, 17, 30 exactly, and the level 17 Cat's 28-37 fits
  (2 x 14.56 x 0.8..1.2 + 75/14 x 2) x 0.75 x 1.10 = 28.0-37.7. So the readings, if real, fit their
  formula and not ours: our model gives 13.3-16.7 at level 11 (vs 20-27) and about 12.7-16.1 for the
  level 17 Cat (vs 28-37). The sheet readings are secondhand. Confidence: medium-high that Forever
  pets use ExpectedStat creature damage rather than vmangos' Classic formula (the AP values
  matching to the integer is hard to get by chance).
- Our own calibration (packages/data/calibration/beta-level30.toml, keeiGM1B-LU, Oct 12, pre-Oct 16
  build): level 30 wolf at 1.2 sec hit 41-61 on a level 23 mob; pet melee was 0.54 to 1.07 of Auto
  Shot damage in three boss fights (pet melee 26% of total in the Dalaran fight, sheet-23705.png).
  By my rough hand calculation (Unleashed Fury 5 assumed +20%, happiness 1.25, armor 24.7%):
  wowsims' formula, normalized to 1.2 sec, gives about 40-53; ours gives about 27-34 normalized, or
  45-56 if a 1.2 sec pet then dealt full 2.0 sec damage per hit. Ambiguous because of the next
  point.

### 1b Attack speed normalization and beast training passives
- Ours: everything at 2.0 sec (overrides.toml:229 pet.attackSpeedSec), no Faster/Slower Attack,
  Cobra Reflexes or Pet Aggression.
- wowsims: the pet carries a Faster/Slower Attack passive (client 1263099-1263114, e.g. Faster
  Attack II +25%), damage per swing divided by the speedup (pets.go ApplyTalents); Cobra Reflexes
  (25076, +30% speed) at x0.85 damage ("TBC's 15% kept", a guess), so +10.5% DPS; Pet Aggression
  rank 5 (6317: +8 damage done, shows as "PhysicalDamage 8" in the log). His export uses Faster
  Attack II + Cobra Reflexes + Pet Aggression 5: 1.23 sec swings, 146 swings per fight. "More
  swings" in the wowsims pet is these options.
- Player reports in beta are split: Oct 6 forum thread (us.forums.blizzard.com/en/wow/t/2373725):
  "The faster pets are hitting as hard as slower pets and doing much more dps" (Detritus) vs "They
  have a normalized DPS" (Gamergrandma); EU consolidated feedback Oct 11 (eu.forums.blizzard.com
  /en/wow/t/634929): "A Cat with 1.2 attack speed currently deals more DPS than a Cat with 2.0 attack
  speed". No Blizzard reply and no patch note normalizing it. The level 17 sheet reading supports
  normalization in a later build. Confidence: low-medium either way.

### 1c Crit inherited from the hunter (Blizzard-confirmed)
- Ours: pet.baseCritPct 5 (guess, overrides.toml:224) plus pet auras, minus suppression: 2.4% in his
  fight. No inheritance.
- wowsims: pets.go makeStatInheritance/inheritedCrit: the higher of the owner's melee and ranged
  crit. 35.5% on the pet sheet in the debug log, 34% observed.
- Blizzard, WoW Forever Beta Development Notes, Oct 16 update
  (https://us.forums.blizzard.com/en/wow/t/2360696): "Fixed an issue where pets were only ever
  inheriting the player's Melee Critical Strike chance" (the rest, per guides: "instead of whichever
  is higher, melee or ranged"). Warcraft Tavern hunter guide
  (https://warcrafttavern.com/forever/guides/hunter/): "Your pet also inherits 100% of your Critical
  Strike Chance." wowsims PR 416 (Oct 13, before the fix) measured melee crit inheritance from logs.
  Confidence: high that pets inherit the hunter's crit; the higher of melee or ranged.

### 1d Attack power and hit inherited
- Blizzard deep dive (https://news.blizzard.com/en-us/article/24301515/): "Pets now get increased
  stats based on their Hunter's gear." and "Pets can no longer receive player buffs that increase
  their stats." Warcraft Tavern: "Your pet also gains 10% of your Melee or Ranged Attack Power,
  whichever is highest." Ours: 10% of ranged AP only (pet.ts:122-125, overrides.toml:197, source
  "wow-forever-rotation.vercel.app assumption"). Same 10% as wowsims, which takes max(melee,
  ranged) x 0.1. Confidence: medium-high on 10%; source upgrade available.
- Hit: forever-bugs issue 394 (https://github.com/ClassicWoWCommunity/forever-bugs/issues/394),
  closed 2026-10-20 by AidanZMoon: "Hunter's give melee hit equal to their ranged hit, and then
  spell hit to their pet equal to 17/8ths of their ranged hit." Blizzard Oct 16: "Pets now correctly
  benefit from Expertise." Ours: pet miss 14.6% vs wowsims 9.5% on his setup (no inherited hit).
- Client: spell 415429 "Hunter Pet Scaling" is in the Forever client with 19 effects (health, AP,
  crit, hit, spell hit, resistances, expertise), all base points 0 (server-priced). It is a Season
  of Discovery id, so its presence alone proves nothing; the Blizzard notes do.

### 1e Focus regeneration (side finding)
- Ours: 10 focus/sec (overrides.toml:211, guess from wow-forever-rotation). Our cat casts 74 Claws a
  fight; wowsims' casts 18 Claws and 15 Bites.
- wowsims: 25 focus per 5 sec = 5/sec (sim/core/focus.go:26-33). vmangos Pet::RegenerateFocus: 25
  per REGEN_TIME_CREATURE_FULL (5000 ms, UnitDefines.h:66) = 5/sec. Forever forum feedback says
  focus "appears to regenerate continuously" in Forever (EU thread 634929), rate unknown.
  Confidence: medium that 5/sec is the Classic rate; our 10 is unsupported.

Recommendation (pet): crit inheritance and hit inheritance have Blizzard / bug tracker backing and
should be modelled. AP 10% of the higher AP can cite Blizzard + Warcraft Tavern. Base damage from
ExpectedStat is well supported but secondhand; attack speed normalization and Cobra Reflexes' 15%
are open. Focus 10/sec has no source; 5/sec has two (vmangos, wowsims). Our hawk share
(pet.hawk.hitPctOfPetMelee) was measured against a real pet hit, so it stays valid only if the pet
model matches the real pet.

---

## 4 Weaving

What we do: packages/engine/src/sim.ts:477-532. Walk 12 -> 4.99 yd at run speed (config.ts:74-80,
overrides.toml:73 7 yd/sec), weave only if the main hand is ready on arrival and Auto Shot slips by
at most maxAutoShotDelayMs (1200 default); one swing the instant we arrive, melee GCD abilities that
are ready, then back out; Auto Shot restarts after a 100 ms reaction plus the 0.5 sec stand-still.

What wowsims does: ui/specs/hunter/dps/apls/default.apl.json variables: Ranged range 12, Shoot spot
max(12, 11.67), Walk-in range 4.99, Run speed = unit movement speed, Max Auto Shot delay 1.2 s, Max
long weave delay 4 s, Time to weave 100 ms; "Weave fits" when the Auto Shot delay is within the
allowed delay. Same geometry as ours. PR 575 ("Hunter/weave flow") and PR 569 have empty
descriptions, so the 1.2 s "measured best" in our config.ts comment traces only to the APL value.

New evidence: wowsims PR 662 (open, ArcSim, 2026-10-24,
https://github.com/wowsims/forever/pull/662), measured in the beta with an addon
(https://github.com/ArcSim/ArcSwingProbe): with the attack turned on at range, a ready main hand
does not swing on arrival; it swings on a 0.5 sec retry grid counted from the later of the swing
timer ending and the attack turning on, about 50 ms after the server sees you in range. 17 of 18
walk-ins fit. Starting the attack on arrival (or ARC 1 presumably) swings at once. 88 of 169 late
dungeon swings sit on the half-second grid vs 12% by chance. In wowsims this costs the default weave
APL 11% (878 -> 777) if the attack is started at range; starting it on arrival costs 1.5%. Maintainer
pushback: "too variable ... too few hits". Confidence: medium.
Our weave swings instantly on arrival (sim.ts:503-507), which matches only the "attack started on
arrival" case.

How many weaves are realistic: no hard source. Blizzard's deep dive frames weaving as intended
("dance back and forth between ranged and melee combat"); Warcraft Tavern calls Survival "a
melee-weaving specialization". Beta stream commentary in our caption cache (keeiGM1B-LU, about
1:32:46): the two-hander melee weaving build "peaked very high but on average it was pretty low".
Recommendation: model the 0.5 sec retry as an option (start attack on arrival vs at range); keep BM
and MM ranged by default as now.

---

## Sources

- Blizzard, WoW Forever Beta Development Notes (Sept 24 - Oct 16 updates):
  https://us.forums.blizzard.com/en/wow/t/2360696
- Blizzard, Forever Class Deep Dives, Hunter and Druid: https://news.blizzard.com/en-us/article/24301515/
- Warcraft Tavern Forever hunter guide: https://warcrafttavern.com/forever/guides/hunter/
- wowsims PRs: https://github.com/wowsims/forever/pull/664 (Serpent Sting 0.030),
  /pull/662 (swing retry), /pull/416 (pet melee crit), /pull/635 (pet hit 17:8), /pull/486
  (expertise), /pull/452 (Serpent Sting crits, hawk speed)
- ArcSim raw beta log: https://gist.github.com/ArcSim/9ef18a6ea02db6588e213b6225201225
- forever-bugs issue 394: https://github.com/ClassicWoWCommunity/forever-bugs/issues/394
- Pet attack speed threads: https://us.forums.blizzard.com/en/wow/t/hunter-pets/2373725 ,
  https://eu.forums.blizzard.com/en/wow/t/634929/1
- vmangos: src/game/Objects/Pet.cpp (InitStatsForLevel, RegenerateFocus), src/game/StatSystem.cpp
  (Pet::UpdateDamagePhysical), src/game/Objects/UnitDefines.h (REGEN_TIME_CREATURE_FULL 5000)
- Forever client: packages/data/raw/1.60.1.70532 SpellEffect.csv, Spell.csv; ExpectedStat from
  https://wago.tools/db2/ExpectedStat/csv?build=1.60.1.70532
- Unreadable (404): github.com/ElliotWood/Forever PRs 592, 707

---

## Addendum (2026-10-26, later): pet hits in the public beta log, and pet crit

Parsed with `sim log` (task 13) from ArcSim's gist log (Elwynn, 2026-10-17, advanced logging). Every
pet swing carries the pet's level and attack power; "before armor" is the hit before armor and
before the crit multiplier, with the pet's own modifiers (family, happiness, Unleashed Fury) in it.
Ranges are the logged before-armor hits; models per swing at the pet's measured speed.

| Pet | Level | AP | Speed | Hits | Logged | wowsims (ExpectedStat) | Ours (vmangos) |
|---|---|---|---|---|---|---|---|
| Fox | 8 | 65 | 2.0 | 13 | 31-36 | 18.9-23.7 | 14.0-17.7 |
| Bastone | 26 | 128 | 1.7? (2 hits) | 2 | 60-61 | 43.8-58.2 | 36.8-46.4 |
| Gordito | 28 | 139 | unknown | 5 | 58-62 | 56.7-75.1 at 2.0 | 47.9-60.4 at 2.0 |
| Nero | 34 | 147 | 1.31 | 6 | 45-53 | 42.5-56.9 | 36.4-46.0 |

- Ours is low at every level. wowsims' ExpectedStat model fits the level 26-34 pets; neither fits
  the level 8 fox (about 1.5 times wowsims). Logged spreads are about ±8%, narrower than either
  model's (±20% wowsims, ±12% ours). The sample is small and the pets' talents and families unknown.
- Nero swings every 1.31 sec for about 0.65 of a 2.0 sec pet's hit: faster pets look normalized to
  the same DPS here.
- A boar logs level 2 with its attack power alternating 44 and 108 between swings; left out.

Pet crit: wowsims PR 416 (2026-10-13) measured from Warcraft Logs reports PryVAfgK7cqbYLRj and
6mQC81KVWwDfJHqa that the pet inherited only the owner's melee crit, with ranged crit separated by
setting one hand's weapon skill to 1. That is the bug Blizzard fixed on Oct 16 ("pets were only ever
inheriting the player's Melee Critical Strike chance"), so it does not change 1c: after the fix the
pet takes the hunter's crit (wowsims: the higher of melee and ranged). With normal weapon skills the
two are the same number; Forever has one crit stat (the user remembers no melee/ranged split).

More logs: wowsims PRs cite Forever beta reports on vanilla.warcraftlogs.com (8R9P1hvDtjJ7r3cw,
TBqwNKxVW8H3narp, T7GB4KhFXyaNVR91, Par9kghHbAVYptwm, mJGyPgZAtr2T4YpX, plus the two above). The site
sits behind Cloudflare; its v2 API needs a free client id and secret.
