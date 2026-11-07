-- Trueshot: reminds the hunter before a pull of what is easy to forget (see Reminders below), and
-- saves the hunter's character sheet (level, ranged attack power, bow speed and damage,
-- crit, hit, stats, buffs, gear, talents, pet) whenever any of it changes, for Trueshot's
-- `sim ingest` to line up with the combat log by time. The combat log lacks these: it logs a
-- player's item level, not level, and an attack power that is not ranged attack power.
--
-- Also records every action bar and pet bar button press (what the button held, the spell it casts,
-- and whether you were in combat), so a fight review can show presses that did nothing and the
-- busiest buttons for keybinds. The combat log only sees spells that went off.
--
-- Also turns combat logging (with advanced logging) on at every login and zone change, since the
-- game turns it off at logout. `/ts autolog off` stops that.
--
-- Saved per login session: the local wall clock at a whole second, the GetTime() at that second, and
-- rows of "key=value;..." with t, milliseconds since that second. Rows are written only when a value
-- differs from the row before. Presses are "t;slot;kind;spell;combat;name" on the same clock. WoW
-- writes SavedVariables at logout or /reload.

-- Sessions kept: at most this many, and none older than MAX_SESSION_DAYS, so SavedVariables stay small.
local MAX_SESSIONS = 60
local MAX_SESSION_DAYS = 30
-- Presses kept per session; hours of play stay well under it.
local MAX_PRESSES = 50000
-- Events that can change the sheet. Ones this client does not know are skipped.
local EVENTS = {
  "UNIT_AURA", "UNIT_INVENTORY_CHANGED", "PLAYER_EQUIPMENT_CHANGED", "PLAYER_LEVEL_UP", "CHARACTER_POINTS_CHANGED",
  "PLAYER_TALENT_UPDATE", "UNIT_RANGED_ATTACK_POWER", "UNIT_ATTACK_POWER", "UNIT_RANGEDDAMAGE", "UNIT_DAMAGE",
  "UNIT_ATTACK_SPEED", "UNIT_STATS", "UNIT_PET", "UNIT_LEVEL", "COMBAT_RATING_UPDATE", "PLAYER_DAMAGE_DONE_MODS",
  "TRAIT_CONFIG_UPDATED", "TRAIT_NODE_CHANGED", "ACTIVE_COMBAT_CONFIG_CHANGED", "PLAYER_REGEN_ENABLED",
}

local frame = CreateFrame("Frame")
local session
local last
-- GetTime() of the first event in a burst, or nil when none waits.
local pendingAt

-- Forever hides some unit values from addons as secret numbers (retail's restrictions), mostly in
-- combat: no arithmetic, comparison or formatting. A sheet that meets one is not saved (a blank
-- would read as 0), so the last whole sheet stays in force until combat ends.
local sawSecret = false
local function secret(x)
  if issecretvalue ~= nil and issecretvalue(x) then
    sawSecret = true
    return true
  end
  return false
end

-- Attack power's base + buffs + debuffs, or nil when any part is secret.
local function sum(base, pos, neg)
  if base == nil or secret(base) or secret(pos) or secret(neg) then return nil end
  return base + (pos or 0) + (neg or 0)
end

local function num(x)
  if x == nil or secret(x) then return "" end
  if x == math.floor(x) then return tostring(x) end
  return string.format("%.3f", x)
end

-- Name lookups that moved to C_Spell and C_Item in later clients.
local function spellName(id)
  if not id then return nil end
  if C_Spell and C_Spell.GetSpellName then return C_Spell.GetSpellName(id) end
  return (GetSpellInfo(id))
end

local function itemSpell(id)
  if C_Item and C_Item.GetItemSpell then return select(2, C_Item.GetItemSpell(id)) end
  return GetItemSpell and select(2, GetItemSpell(id))
end

local function itemName(id)
  if C_Item and C_Item.GetItemNameByID then return C_Item.GetItemNameByID(id) end
  return (GetItemInfo(id))
end

local function buffIds(unit)
  local ids = {}
  for i = 1, 64 do
    local id
    if C_UnitAuras and C_UnitAuras.GetBuffDataByIndex then
      local aura = C_UnitAuras.GetBuffDataByIndex(unit, i)
      id = aura and aura.spellId
    else
      id = select(10, UnitBuff(unit, i))
    end
    if not id then break end
    ids[#ids + 1] = id
  end
  table.sort(ids)
  return table.concat(ids, ",")
end

-- "slot:id:enchant:suffix" for each worn item.
local function gear()
  local out = {}
  for slot = 1, 19 do
    local link = GetInventoryItemLink("player", slot)
    local id, enchant, suffix
    if link then
      id, enchant, suffix = link:match("item:(%d+):(%d*):[^:]*:[^:]*:[^:]*:[^:]*:([%-%d]*)")
    end
    if id then out[#out + 1] = slot .. ":" .. id .. ":" .. (enchant or "") .. ":" .. (suffix or "") end
  end
  return table.concat(out, ",")
end

-- Forever runs the retail talent system (C_ClassTalents, C_Traits; GetNumTalentTabs is nil):
-- "spellID:rank" for each talent with points in it, sorted by spell. Choice nodes report the
-- chosen entry's spell.
local function traitTalents()
  local configID = C_ClassTalents.GetActiveConfigID and C_ClassTalents.GetActiveConfigID()
  local config = configID and C_Traits.GetConfigInfo(configID)
  if not config or not config.treeIDs then return nil end
  local out = {}
  for _, treeID in ipairs(config.treeIDs) do
    for _, nodeID in ipairs(C_Traits.GetTreeNodes(treeID) or {}) do
      local node = C_Traits.GetNodeInfo(configID, nodeID)
      local rank = node and (node.activeRank or node.currentRank) or 0
      local entryID = node and rank > 0 and ((node.activeEntry and node.activeEntry.entryID) or (node.entryIDs and node.entryIDs[1]))
      local entry = entryID and C_Traits.GetEntryInfo(configID, entryID)
      local def = entry and entry.definitionID and C_Traits.GetDefinitionInfo(entry.definitionID)
      local spell = def and (def.spellID or def.overriddenSpellID)
      if spell then out[#out + 1] = { spell, rank } end
    end
  end
  table.sort(out, function(a, b) return a[1] < b[1] end)
  for i, t in ipairs(out) do out[i] = t[1] .. ":" .. t[2] end
  return table.concat(out, ",")
end

-- Each tree's ranks in talent order, trees split by "/" (the Classic API), else the trait list
-- above. A client with neither leaves it empty.
local function talents()
  if not GetNumTalentTabs and C_ClassTalents and C_Traits then
    local ok, list = pcall(traitTalents)
    return ok and list or ""
  end
  local trees = {}
  for tab = 1, (GetNumTalentTabs and GetNumTalentTabs() or 0) do
    local ranks = {}
    for i = 1, GetNumTalents(tab) do
      ranks[#ranks + 1] = select(5, GetTalentInfo(tab, i)) or 0
    end
    trees[#trees + 1] = table.concat(ranks)
  end
  return table.concat(trees, "/")
end

local function sheet()
  local v = {}
  local add = function(k, x) v[#v + 1] = k .. "=" .. x end
  add("level", num(UnitLevel("player")))
  add("rap", num(sum(UnitRangedAttackPower("player"))))
  add("ap", num(sum(UnitAttackPower("player"))))
  local speed, low, high, _, _, pct = UnitRangedDamage("player")
  add("rspeed", num(speed))
  add("rmin", num(low))
  add("rmax", num(high))
  add("rpct", num(pct))
  add("rcrit", num(GetRangedCritChance()))
  add("mcrit", num(GetCritChance()))
  add("hit", num(GetHitModifier and GetHitModifier() or 0))
  for i, name in ipairs({ "str", "agi", "sta", "int", "spi" }) do
    add(name, num(select(2, UnitStat("player", i))))
  end
  add("armor", num(select(2, UnitArmor("player"))))
  add("buffs", buffIds("player"))
  add("gear", gear())
  add("talents", talents())
  if UnitExists("pet") then
    add("pet", UnitCreatureFamily("pet") or "")
    add("petlevel", num(UnitLevel("pet")))
    add("petap", num(sum(UnitAttackPower("pet"))))
    add("petspeed", num(UnitAttackSpeed("pet")))
    low, high = UnitDamage("pet")
    add("petmin", num(low))
    add("petmax", num(high))
    add("petbuffs", buffIds("pet"))
  end
  return table.concat(v, ";")
end

-- The bow's speed as last read out of combat (it is secret in combat), for the after-fight summary.
local bowSpeed

local function flush()
  local at = pendingAt or GetTime()
  pendingAt = nil
  local ok, speed = pcall(UnitRangedDamage, "player")
  if ok and speed ~= nil and not (issecretvalue ~= nil and issecretvalue(speed)) and speed > 0 then bowSpeed = speed end
  if not session then return end
  -- A value this client guards in a new way must not stop the recorder.
  sawSecret = false
  local ok, row = pcall(sheet)
  if not ok or sawSecret or row == last then return end
  last = row
  session.rows[#session.rows + 1] = "t=" .. math.floor((at - session.gt) * 1000 + 0.5) .. ";" .. row
end

local function press(slot, kind, spell, name)
  if not session or #session.presses >= MAX_PRESSES then return end
  local combat = UnitAffectingCombat("player") and 1 or 0
  session.presses[#session.presses + 1] = math.floor((GetTime() - session.gt) * 1000 + 0.5) .. ";" .. slot .. ";" .. kind
    .. ";" .. (spell or 0) .. ";" .. combat .. ";" .. (name or "")
end

-- Every action button press goes through UseAction, keybinds and clicks alike, whatever bar addon
-- draws the button.
local function onUseAction(slot)
  local kind, id = GetActionInfo(slot)
  if not kind then return end
  local spell, name
  if kind == "spell" and (not id or id == 0) then
    -- A pet bar action (Attack, Follow, a pet ability) dragged to the main bar reports spell 0:
    -- find it on the pet bar by its icon.
    -- Action textures come back as file IDs, pet bar ones as paths or global tokens.
    local function fileID(t)
      if type(t) == "string" and GetFileIDFromPath then return GetFileIDFromPath(t) or t end
      return t
    end
    local icon = fileID(GetActionTexture(slot))
    for i = 1, NUM_PET_ACTION_SLOTS or 10 do
      local petName, petIcon, isToken, _, _, _, petSpell = GetPetActionInfo(i)
      if petName and icon and fileID(isToken and _G[petIcon] or petIcon) == icon then
        if isToken then petName = _G[petName] or petName end
        press(slot, "pet", type(petSpell) == "number" and petSpell or nil, petName)
        return
      end
    end
    name = "Pet action"
  elseif kind == "spell" then
    spell = id
    name = spellName(id)
  elseif kind == "macro" then
    name = GetMacroInfo(id)
    spell = GetMacroSpell and GetMacroSpell(id)
  elseif kind == "item" then
    spell = itemSpell(id)
    name = itemName(id)
  end
  press(slot, kind, spell, name or GetActionText(slot) or (kind .. " " .. tostring(id)))
end

-- Pet bar buttons: Attack, Follow, Stay and the pet's abilities.
local function onPetAction(index)
  local name, _, isToken, _, _, _, spell = GetPetActionInfo(index)
  if not name then return end
  if isToken then name = _G[name] or name end
  press(index, "pet", type(spell) == "number" and spell or nil, name)
end

local function changed()
  if pendingAt then return end
  pendingAt = GetTime()
  -- One read per burst of events (a buff and its stat events land together).
  C_Timer.After(0.05, flush)
end

-- Anchor the session at the moment the wall clock ticks over a second, so rows convert to the
-- combat log's millisecond timestamps.
local function startSession()
  local db = TrueshotDB
  local second = time()
  local ticker
  ticker = C_Timer.NewTicker(0.001, function()
    if time() == second then return end
    ticker:Cancel()
    session = {
      wall = date("%m/%d/%Y %H:%M:%S"),
      started = second + 1,
      gt = GetTime(),
      guid = UnitGUID("player"),
      name = UnitName("player"),
      realm = GetRealmName(),
      rows = {},
      presses = {},
    }
    db.sessions[#db.sessions + 1] = session
    -- Sessions saved before `started` existed age out by count alone.
    local oldest = time() - MAX_SESSION_DAYS * 86400
    while #db.sessions > 1 and (#db.sessions > MAX_SESSIONS or (db.sessions[1].started or oldest) < oldest) do
      table.remove(db.sessions, 1)
    end
    flush()
  end)
end

local function autolog()
  if not TrueshotDB.autolog then return end
  if GetCVar("advancedCombatLogging") ~= "1" then SetCVar("advancedCombatLogging", "1") end
  if not LoggingCombat() then
    LoggingCombat(true)
    print("|cffabd473Trueshot|r: combat logging on")
  end
end

frame:SetScript("OnEvent", function(_, event, unit)
  if event == "PLAYER_LOGIN" then
    TrueshotDB = TrueshotDB or {}
    TrueshotDB.sessions = TrueshotDB.sessions or {}
    if TrueshotDB.autolog == nil then TrueshotDB.autolog = true end
    if select(2, UnitClass("player")) ~= "HUNTER" then return end
    for _, e in ipairs(EVENTS) do pcall(frame.RegisterEvent, frame, e) end
    -- Press tracking must never throw into the player's button press.
    hooksecurefunc("UseAction", function(...) pcall(onUseAction, ...) end)
    if CastPetAction then hooksecurefunc("CastPetAction", function(...) pcall(onPetAction, ...) end) end
    startSession()
    -- Talent changes fire no event this addon receives on Forever (2026-11-06: spent points showed
    -- up only with the next unrelated event), so look every 10 sec; an unchanged sheet is not saved.
    if C_Timer.NewTicker then C_Timer.NewTicker(10, changed) end
  elseif event == "PLAYER_ENTERING_WORLD" then
    autolog()
    changed()
  elseif unit == nil or unit == "player" or unit == "pet" then
    changed()
  end
end)
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")

-- Reminders ==================================================================
-- Before a pull: when you target something hostile out of combat, Trueshot checks what is easy to
-- forget and shows one short line in the middle of the screen. Only plain values out of combat are
-- read, so Forever's secret values never get in the way. `/ts remind off` turns it off.

local REMIND_EVERY = 30 -- seconds before the same reminder shows again
local LOW_MANA = 0.5    -- share of mana under which a big pull gets a "drink first"
local LOW_AMMO = 200
local CALL_PET = 883
local HAWK_ASPECT = 13165

local remindFrame = CreateFrame("Frame", nil, UIParent)
remindFrame:SetSize(600, 60)
remindFrame:SetPoint("TOP", UIParent, "TOP", 0, -180)
remindFrame:Hide()
local remindText = remindFrame:CreateFontString(nil, "OVERLAY")
remindText:SetFont(STANDARD_TEXT_FONT, 20, "OUTLINE")
remindText:SetPoint("CENTER")
remindText:SetTextColor(0.67, 0.83, 0.45)
local remindHide
local lastShown = {}

local function plain(x)
  return x ~= nil and not (issecretvalue ~= nil and issecretvalue(x))
end

local function knows(id)
  if IsPlayerSpell then return IsPlayerSpell(id) end
  return IsSpellKnown and IsSpellKnown(id)
end

-- The names of the player's buffs, or nil when they cannot be read.
local function buffNames()
  local names = {}
  for i = 1, 40 do
    local name
    if C_UnitAuras and C_UnitAuras.GetAuraDataByIndex then
      local a = C_UnitAuras.GetAuraDataByIndex("player", i, "HELPFUL")
      name = a and a.name
    elseif UnitBuff then
      name = UnitBuff("player", i)
    end
    if name == nil then break end
    if not plain(name) then return nil end
    names[#names + 1] = name
  end
  return names
end

-- What to remind about right now, most important first.
local function reminders()
  local out = {}
  if knows(CALL_PET) then
    if not UnitExists("pet") then
      out[#out + 1] = "no pet out"
    elseif UnitIsDead("pet") then
      out[#out + 1] = "pet is dead"
    elseif GetPetHappiness then
      local happiness = GetPetHappiness()
      if plain(happiness) and happiness == 1 then out[#out + 1] = "pet is unhappy, feed it" end
    end
  end
  local names = buffNames()
  if names and knows(HAWK_ASPECT) then
    local aspect
    for _, n in ipairs(names) do
      if n:find("^Aspect of the") then aspect = n end
    end
    if not aspect then
      out[#out + 1] = "no Aspect"
    elseif aspect:find("Cheetah") or aspect:find("Pack") then
      out[#out + 1] = aspect .. " is on"
    end
  end
  local mana, maxMana = UnitPower("player", 0), UnitPowerMax("player", 0)
  local classification = UnitClassification("target")
  local big = classification == "elite" or classification == "worldboss" or classification == "rareelite" or IsInInstance()
  if big and plain(mana) and plain(maxMana) and maxMana > 0 and mana / maxMana < LOW_MANA then
    out[#out + 1] = string.format("mana %d%%: drink first", math.floor(100 * mana / maxMana))
  end
  local ok, ammo = pcall(GetInventoryItemCount, "player", 0)
  if ok and plain(ammo) and GetInventoryItemID("player", 0) and ammo < LOW_AMMO then
    out[#out + 1] = string.format("%d arrows left", ammo)
  end
  return out
end

local function remind()
  if not TrueshotDB.remind or InCombatLockdown() then return end
  if not UnitExists("target") or not UnitCanAttack("player", "target") or UnitIsDead("target") then return end
  local now = GetTime()
  local fresh = {}
  for _, r in ipairs(reminders()) do
    if not lastShown[r] or now - lastShown[r] > REMIND_EVERY then
      fresh[#fresh + 1] = r
      lastShown[r] = now
    end
  end
  if #fresh == 0 then return end
  remindText:SetText(table.concat(fresh, "   /   "))
  remindFrame:Show()
  if remindHide then remindHide:Cancel() end
  remindHide = C_Timer.NewTimer(4, function() remindFrame:Hide() end)
end

local remindEvents = CreateFrame("Frame")
remindEvents:SetScript("OnEvent", function(_, event)
  if event == "PLAYER_LOGIN" then
    TrueshotDB = TrueshotDB or {}
    if TrueshotDB.remind == nil then TrueshotDB.remind = true end
    if select(2, UnitClass("player")) == "HUNTER" then remindEvents:RegisterEvent("PLAYER_TARGET_CHANGED") end
  elseif event == "PLAYER_TARGET_CHANGED" then
    pcall(remind)
  end
end)
remindEvents:RegisterEvent("PLAYER_LOGIN")
TrueshotReminders = reminders

-- After-fight summary ========================================================
-- Your own casts and the game clock stay readable in combat (`/ts probe`, 2026-11-07); damage does
-- not (the combat log event is blocked for addons, and amounts, health and mana are secret). So at
-- the end of a fight Trueshot prints one line from timing alone: Auto Shots fired against what the
-- bow allowed, the late ones and the time they cost, and your casts. Haste it cannot see (Quick
-- Shots, the quiver) makes shots look early, never late, so "late" stays honest; Rapid Fire's 40% is
-- counted. Each summary is also saved, so `sim review` can check it against the log.
-- `/ts summary off` turns it off.

local AUTO_SHOT = 75
local RAPID_FIRE = 3045
local RAPID_FIRE_SEC = 15
local RAPID_FIRE_HASTE = 1.4
local LATE_SLACK = 0.3   -- seconds over the bow's speed before a shot counts as late
local STOPPED = 5        -- a gap longer than this is a stop (moving, out of range), not a late shot
local MIN_FIGHT = 8      -- seconds; shorter fights get no summary

local fight

local function fightStart()
  fight = { start = GetTime(), shots = {}, casts = {}, rapid = {}, speed = bowSpeed }
end

local function fightCast(spellID)
  if not fight or not spellID then return end
  local now = GetTime()
  if spellID == AUTO_SHOT then
    fight.shots[#fight.shots + 1] = now
    return
  end
  if spellID == RAPID_FIRE then fight.rapid[#fight.rapid + 1] = now end
  local name = spellName(spellID) or tostring(spellID)
  fight.casts[name] = (fight.casts[name] or 0) + 1
end

-- The bow's speed at a moment, with Rapid Fire's haste when it was up.
local function speedAt(f, t)
  for _, r in ipairs(f.rapid) do
    if t >= r and t <= r + RAPID_FIRE_SEC then return f.speed / RAPID_FIRE_HASTE end
  end
  return f.speed
end

-- The summary of a finished fight, or nil when there is nothing worth saying.
local function summarize(f, now)
  local length = now - f.start
  if length < MIN_FIGHT then return nil end
  local n = #f.shots
  local parts = {}
  local saved = { start = f.start, length = length, shots = n }
  if n >= 2 and f.speed then
    local late, lost, stops, stopped = 0, 0, 0, 0
    -- Shots the bow allowed between the first and the last, from the time each gap could hold.
    local possible = 1
    for i = 2, n do
      local gap = f.shots[i] - f.shots[i - 1]
      local speed = speedAt(f, f.shots[i - 1])
      possible = possible + math.max(1, math.floor(gap / speed + 0.25))
      if gap > STOPPED then
        stops = stops + 1
        stopped = stopped + gap
      elseif gap > speed + LATE_SLACK then
        late = late + 1
        lost = lost + gap - speed
      end
    end
    parts[#parts + 1] = string.format("Auto Shot %d of %d", n, possible)
    if late > 0 then parts[#parts + 1] = string.format("%d late (%.1f sec lost)", late, lost) end
    if stops > 0 then parts[#parts + 1] = string.format("stopped %d %s (%.0f sec)", stops, stops == 1 and "time" or "times", stopped) end
    saved.possible, saved.late, saved.lost, saved.stops = possible, late, lost, stops
  elseif n >= 2 then
    parts[#parts + 1] = string.format("Auto Shot %d (bow speed unknown)", n)
  end
  local casts = {}
  for name, c in pairs(f.casts) do casts[#casts + 1] = { name, c } end
  table.sort(casts, function(a, b) return a[2] > b[2] end)
  local list = {}
  for i = 1, math.min(5, #casts) do list[i] = casts[i][1] .. " " .. casts[i][2] end
  if #list > 0 then parts[#parts + 1] = table.concat(list, ", ") end
  if #parts == 0 then return nil end
  return string.format("%.0f sec: %s", length, table.concat(parts, "; ")), saved
end

local summaryEvents = CreateFrame("Frame")
summaryEvents:SetScript("OnEvent", function(_, event, unit, _, spellID)
  if event == "PLAYER_LOGIN" then
    TrueshotDB = TrueshotDB or {}
    if TrueshotDB.summary == nil then TrueshotDB.summary = true end
    if select(2, UnitClass("player")) ~= "HUNTER" then return end
    for _, e in ipairs({ "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED", "UNIT_SPELLCAST_SUCCEEDED" }) do summaryEvents:RegisterEvent(e) end
  elseif event == "PLAYER_REGEN_DISABLED" then
    pcall(fightStart)
  elseif event == "UNIT_SPELLCAST_SUCCEEDED" then
    if unit == "player" then pcall(fightCast, spellID) end
  elseif event == "PLAYER_REGEN_ENABLED" then
    local f = fight
    fight = nil
    if not f or not TrueshotDB.summary then return end
    local ok, line, saved = pcall(summarize, f, GetTime())
    if not ok or not line then return end
    print("|cffabd473Trueshot|r: " .. line)
    if session then
      session.fights = session.fights or {}
      saved.t = math.floor((saved.start - session.gt) * 1000 + 0.5)
      saved.start = nil
      session.fights[#session.fights + 1] = saved
    end
  end
end)
summaryEvents:RegisterEvent("PLAYER_LOGIN")
TrueshotSummarize = summarize

SLASH_TRUESHOT1 = "/trueshot"
SLASH_TRUESHOT2 = "/ts"
SlashCmdList.TRUESHOT = function(msg)
  local db = TrueshotDB
  if msg == "probe" then
    TrueshotProbe.start()
    return
  end
  if msg == "summary off" or msg == "summary on" then
    db.summary = msg == "summary on"
  end
  if msg == "remind off" or msg == "remind on" then
    db.remind = msg == "remind on"
  end
  if msg == "remind" then
    local list = TrueshotReminders()
    print("|cffabd473Trueshot|r: " .. (#list > 0 and table.concat(list, ", ") or "nothing to remind you of"))
    return
  end
  if msg == "autolog off" or msg == "autolog on" then
    db.autolog = msg == "autolog on"
    if db.autolog then autolog() end
  end
  print(string.format(
    "|cffabd473Trueshot|r: %d rows and %d presses this session, %d sessions saved, combat logging %s, autolog %s, reminders %s, fight summary %s",
    session and #session.rows or 0, session and #session.presses or 0, #db.sessions, LoggingCombat() and "on" or "off", db.autolog and "on" or "off",
    db.remind and "on" or "off", db.summary and "on" or "off"
  ))
end

-- `/ts probe`: finds out which game data this client lets an addon read, in and out of combat, to
-- decide what Trueshot can show in game. Off until started; it reports after the next fight ends
-- and saves the findings in TrueshotDB.probe for `sim ingest` and for reading by hand.
--
-- Checked: whether the spellcast events' spell ids and times come back as secret values in combat,
-- and the same for mana, the bow's speed, and the pet's and target's health, in combat and after.
-- The combat log event itself is blocked for addons on Forever, so it is not tried.

local probe = { on = false }
local frame = CreateFrame("Frame")
local P = "|cffabd473Trueshot probe|r: "

local function isSecret(x)
  return issecretvalue ~= nil and issecretvalue(x) or false
end

-- "plain", "secret", "nil", or "secret, math ok" style notes for one value.
local function describe(x)
  if x == nil then return "nil" end
  if isSecret(x) then
    local ok = pcall(function() return x + 0 end)
    return ok and "secret, math works" or "secret"
  end
  return "plain"
end

local function note(key, value)
  local r = probe.results
  r[key] = r[key] or {}
  local phase = InCombatLockdown() and "combat" or "out"
  -- The first answer per phase stands, except nil (a crit flag on a hit that did not crit).
  if r[key][phase] == nil or r[key][phase] == "nil" then r[key][phase] = describe(value) end
end

local function count(key)
  probe.results[key .. " count"] = (probe.results[key .. " count"] or 0) + 1
end

frame:SetScript("OnEvent", function(_, event, unit, _, spellID)
  if event == "UNIT_SPELLCAST_SUCCEEDED" and unit == "player" then
    count("own casts")
    note("cast spell id", spellID)
    note("cast time (GetTime)", GetTime())
  elseif event == "PLAYER_REGEN_DISABLED" then
    probe.results.fights = (probe.results.fights or 0) + 1
    C_Timer.After(2, function()
      note("player mana", UnitPower("player", 0))
      note("bow speed", (UnitRangedDamage("player")))
      note("pet health", UnitHealth("pet"))
      note("target health", UnitHealth("target"))
    end)
  elseif event == "PLAYER_REGEN_ENABLED" then
    C_Timer.After(1, function()
      note("player mana", UnitPower("player", 0))
      note("bow speed", (UnitRangedDamage("player")))
      probe.report()
    end)
  end
end)

function probe.report()
  local r = probe.results
  print(P .. "results so far (also saved in TrueshotDB.probe):")
  local keys = {}
  for k in pairs(r) do keys[#keys + 1] = k end
  table.sort(keys)
  for _, k in ipairs(keys) do
    local v = r[k]
    if type(v) == "table" then
      local parts = {}
      for phase, d in pairs(v) do parts[#parts + 1] = phase .. ": " .. d end
      table.sort(parts)
      print("  " .. k .. " = " .. table.concat(parts, ", "))
    else
      print("  " .. k .. " = " .. tostring(v))
    end
  end
end

function probe.start()
  TrueshotDB.probe = TrueshotDB.probe or {}
  probe.results = TrueshotDB.probe
  probe.results.client = (GetBuildInfo())
  if probe.on then
    probe.report()
    return
  end
  probe.on = true
  for _, e in ipairs({ "UNIT_SPELLCAST_SUCCEEDED", "PLAYER_REGEN_DISABLED", "PLAYER_REGEN_ENABLED" }) do frame:RegisterEvent(e) end
  -- Registering COMBAT_LOG_EVENT_UNFILTERED is a protected action on Forever (2026-11-07: "blocked from
  -- an action only available to the Blizzard UI", with no Lua error), so the probe no longer tries.
  probe.results["register combat log"] = "blocked for addons (2026-11-07)"
  print(P .. "on. Fight something; results print when the fight ends. `/ts probe` again shows them.")
end

TrueshotProbe = probe
