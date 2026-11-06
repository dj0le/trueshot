-- Trueshot: saves the hunter's character sheet (level, ranged attack power, bow speed and damage,
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

local MAX_SESSIONS = 200
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

local function flush()
  local at = pendingAt or GetTime()
  pendingAt = nil
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
      gt = GetTime(),
      guid = UnitGUID("player"),
      name = UnitName("player"),
      realm = GetRealmName(),
      rows = {},
      presses = {},
    }
    db.sessions[#db.sessions + 1] = session
    while #db.sessions > MAX_SESSIONS do table.remove(db.sessions, 1) end
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
  elseif event == "PLAYER_ENTERING_WORLD" then
    autolog()
    changed()
  elseif unit == nil or unit == "player" or unit == "pet" then
    changed()
  end
end)
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")

SLASH_TRUESHOT1 = "/trueshot"
SLASH_TRUESHOT2 = "/ts"
SlashCmdList.TRUESHOT = function(msg)
  local db = TrueshotDB
  if msg == "autolog off" or msg == "autolog on" then
    db.autolog = msg == "autolog on"
    if db.autolog then autolog() end
  end
  print(string.format(
    "|cffabd473Trueshot|r: %d rows and %d presses this session, %d sessions saved, combat logging %s, autolog %s",
    session and #session.rows or 0, session and #session.presses or 0, #db.sessions, LoggingCombat() and "on" or "off", db.autolog and "on" or "off"
  ))
end
