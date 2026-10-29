-- Trueshot: saves the hunter's character sheet (level, ranged attack power, bow speed and damage,
-- crit, hit, stats, buffs, gear, talents, pet) whenever any of it changes, for Trueshot's
-- `sim ingest` to line up with the combat log by time. The combat log lacks these: it logs a
-- player's item level, not level, and an attack power that is not ranged attack power.
--
-- Also turns combat logging (with advanced logging) on at every login and zone change, since the
-- game turns it off at logout. `/ts autolog off` stops that.
--
-- Saved per login session: the local wall clock at a whole second, the GetTime() at that second, and
-- rows of "key=value;..." with t, milliseconds since that second. Rows are written only when a value
-- differs from the row before. WoW writes SavedVariables at logout or /reload.

local MAX_SESSIONS = 200
-- Events that can change the sheet. Ones this client does not know are skipped.
local EVENTS = {
  "UNIT_AURA", "UNIT_INVENTORY_CHANGED", "PLAYER_EQUIPMENT_CHANGED", "PLAYER_LEVEL_UP", "CHARACTER_POINTS_CHANGED",
  "PLAYER_TALENT_UPDATE", "UNIT_RANGED_ATTACK_POWER", "UNIT_ATTACK_POWER", "UNIT_RANGEDDAMAGE", "UNIT_DAMAGE",
  "UNIT_ATTACK_SPEED", "UNIT_STATS", "UNIT_PET", "UNIT_LEVEL", "COMBAT_RATING_UPDATE", "PLAYER_DAMAGE_DONE_MODS",
}

local frame = CreateFrame("Frame")
local session
local last
-- GetTime() of the first event in a burst, or nil when none waits.
local pendingAt

local function num(x)
  if x == nil then return "" end
  if x == math.floor(x) then return tostring(x) end
  return string.format("%.3f", x)
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

-- Each tree's ranks in talent order, trees split by "/".
local function talents()
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
  local base, pos, neg = UnitRangedAttackPower("player")
  add("rap", num(base + pos + neg))
  base, pos, neg = UnitAttackPower("player")
  add("ap", num(base + pos + neg))
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
    base, pos, neg = UnitAttackPower("pet")
    add("petap", num(base + pos + neg))
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
  local row = sheet()
  if row == last then return end
  last = row
  session.rows[#session.rows + 1] = "t=" .. math.floor((at - session.gt) * 1000 + 0.5) .. ";" .. row
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
    "|cffabd473Trueshot|r: %d rows this session, %d sessions saved, combat logging %s, autolog %s",
    session and #session.rows or 0, #db.sessions, LoggingCombat() and "on" or "off", db.autolog and "on" or "off"
  ))
end
