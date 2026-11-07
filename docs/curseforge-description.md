# Trueshot

A small hunter addon for WoW Forever. It reminds you of what's easy to forget before a pull, and it
records what the game's combat log leaves out, so the Trueshot sim can check your fights.

## Before a pull

Target something hostile out of combat and Trueshot shows one line in the middle of your screen if:

- your pet is missing, dead or unhappy
- you have no Aspect up, or Cheetah or Pack is still on
- your mana is under half before an elite or a dungeon pull
- you're low on arrows

Each reminder shows at most once every 30 seconds. `/ts remind` lists what it would remind you of
right now, and `/ts remind off` turns them off.

## Recording

- Turns combat logging (with advanced logging) on every time you log in. The game turns it off at
  logout, and a forgotten log is a lost fight.
- Saves your character sheet whenever it changes: level, ranged attack power, bow speed, crit, hit,
  stats, buffs, gear, talents and pet. The combat log only has your item level and a melee attack
  power, so without this a log can't tell how hard you should have hit.
- Saves your action bar and pet bar presses, so a fight review can show the presses that did
  nothing.

All of it stays on your computer, in your own SavedVariables and combat log folder. Nothing is sent
anywhere.

Combat logs grow fast: an evening of dungeons can write 50 MB. Delete old logs from
`_forever_/Logs` now and then, or stop the automatic logging with `/ts autolog off`.

## Commands

- `/ts`: status
- `/ts remind`, `/ts remind off`, `/ts remind on`
- `/ts autolog off`, `/ts autolog on`
- `/ts probe`: tests which combat data the game lets addons read and reports after your next fight.
  It helps decide what Trueshot can show in game later.

## The sim

The analysis lives in the Trueshot sim on GitHub (https://github.com/dj0le/trueshot): fight reviews,
"what the tooltip says against what your logs show", and DPS sims of talents, pets and rotations. It
runs on your computer and needs [Bun](https://bun.sh). The addon works fine without it.

This is early. Bug reports and odd numbers are welcome on GitHub.
