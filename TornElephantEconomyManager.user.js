// ==UserScript==
// @name         TEEM - Torn's Elephant Economy Manager
// @namespace    https://torn.com
// @version      5.2.6
// @description  TEEM — Torn's Elephant Economy Manager. Market tracker with hot/cold signals, travel profit rankings, war gear calculator, quick item use, battle stats & spy overlays.
// @author       TornTravelTracker
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      yata.life
// @connect      yata.yt
// @connect      tornstats.com
// @connect      www.tornstats.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  try {


  const SCRIPT_KEY   = 'tmit_';
  // Poll intervals are user-configurable via settings — see startPolling()
  // Tiered history retention — keeps long-term trends without storage bloat
  // Resolution tiers per snapshot age:
  //   0-24h:   keep every snapshot (full resolution)
  //   1-7d:    keep one per hour
  //   7d-30d:  keep one per 6 hours
  //   30d+:    keep one per day
  // With 60s polls this gives ~1440 + 144 + 120 + 365 = ~2069 max snapshots per item
  const HISTORY_TIERS = [
    { maxAgeMs:    24 * 3600e3,  resolutionMs:       60e3 }, // last 24h: every minute
    { maxAgeMs:     7 * 86400e3, resolutionMs:     3600e3 }, // 1-7d: hourly
    { maxAgeMs:    30 * 86400e3, resolutionMs: 6 * 3600e3 }, // 7-30d: 6-hourly
    { maxAgeMs: Infinity,        resolutionMs:    86400e3 }, // 30d+: daily
  ];

  const TIMEFRAMES = [
    { label: '1H',  ms: 60 * 60 * 1000,          short: true  },
    { label: '6H',  ms: 6 * 60 * 60 * 1000,       short: true  },
    { label: '1D',  ms: 24 * 60 * 60 * 1000,      short: true  },
    { label: '3D',  ms: 3 * 24 * 60 * 60 * 1000,  short: false },
    { label: '1W',  ms: 7 * 24 * 60 * 60 * 1000,  short: false },
    { label: '2W',  ms: 14 * 24 * 60 * 60 * 1000, short: false },
    { label: '1M',  ms: 30 * 24 * 60 * 60 * 1000, short: false },
  ];

  // Categories built dynamically from whatever Torn API actually returns
  let CATEGORIES = ['All'];

  // ── Bunker Bucks data (used by war calculator and BB tab) ──────────────────
  const BB_TABLE = {
    Yellow: { 'Pistol/SMG': 4, 'Melee': 6, 'Shotgun/Rifle': 10, 'Armour': 12, 'Heavies': 14 },
    Orange: {
      1: { 'Pistol/SMG': 12, 'Melee': 18, 'Shotgun/Rifle': 30, 'Armour': 26, 'Heavies': 42 },
      2: { 'Pistol/SMG': 18, 'Melee': 27, 'Shotgun/Rifle': 45, 'Armour': 26, 'Heavies': 63 },
    },
    Red: {
      1: { 'Pistol/SMG': 36, 'Melee': 54, 'Shotgun/Rifle': 90,  'Armour': 108, 'Heavies': 126 },
      2: { 'Pistol/SMG': 54, 'Melee': 81, 'Shotgun/Rifle': 135, 'Armour': 108, 'Heavies': 189 },
    },
  };

  const BB_CACHE_COSTS = {
    'Yellow Small':   2,  'Yellow Melee':    3,  'Yellow Large':    5,  'Yellow Heavy':    7,
    'Yellow Armour': 12,
    'Orange Small':   6,  'Orange Melee':    9,  'Orange Large':   15,  'Orange Heavy':   21,
    'Orange Armour': 13,
    'Red Small':     18,  'Red Melee':       27,  'Red Large':      45,  'Red Heavy':      63,
    'Red Armour':    54,
  };

  function getBBValue(rarity, bonuses, weaponType) {
    if (!rarity || !weaponType) return 0;
    const r = rarity.charAt(0).toUpperCase() + rarity.slice(1).toLowerCase();
    if (r === 'Yellow') return BB_TABLE.Yellow[weaponType] ?? 0;
    const b = Math.min(2, Math.max(1, parseInt(bonuses) || 1));
    return BB_TABLE[r]?.[b]?.[weaponType] ?? 0;
  }

  // ── Travel data ─────────────────────────────────────────────────────────────
  // Travel countries — items identified by NAME, resolved to IDs at runtime
  // Sources: Torn wiki, community guides (verified Aug 2025)
  // Buy prices = in-store abroad price (Torn $)
  // Travel times = one-way economy flight in minutes
  // Capacity = approximate max items available per restock cycle
  const COUNTRIES = [
    {
      name: 'Mexico', code: 'mex', flagEmoji: '🇲🇽', travelTime: 20,
      items: [
        { itemName: 'Jaguar Plushie', buyPrice: 10000, capacity: 400  },
        { itemName: 'Dahlia',         buyPrice: 300,   capacity: 1000 },
      ]
    },
    {
      name: 'Cayman Islands', code: 'cay', flagEmoji: '🇰🇾', travelTime: 57,
      items: [
        { itemName: 'Stingray Plushie', buyPrice: 400,  capacity: 400  },
        { itemName: 'Banana Orchid',    buyPrice: 4000, capacity: 1000 },
      ]
    },
    {
      name: 'Canada', code: 'can', flagEmoji: '🇨🇦', travelTime: 41,
      items: [
        { itemName: 'Wolverine Plushie', buyPrice: 30,  capacity: 400  },
        { itemName: 'Crocus',            buyPrice: 600, capacity: 1000 },
        { itemName: 'Xanax',             buyPrice: 750, capacity: 100  },
      ]
    },
    {
      name: 'Hawaii', code: 'haw', flagEmoji: '🌺', travelTime: 121,
      items: [
        { itemName: 'Orchid',         buyPrice: 700,      capacity: 1000 },
        { itemName: 'Large Suitcase', buyPrice: 10000000, capacity: 100  },
      ]
    },
    {
      name: 'United Kingdom', code: 'uk', flagEmoji: '🇬🇧', travelTime: 159,
      items: [
        { itemName: 'Red Fox Plushie', buyPrice: 1000, capacity: 400  },
        { itemName: 'Nessie Plushie',  buyPrice: 200,  capacity: 400  },
        { itemName: 'Heather',         buyPrice: 5000, capacity: 1000 },
        { itemName: 'Xanax',           buyPrice: 750,  capacity: 100  },
      ]
    },
    {
      name: 'Argentina', code: 'arg', flagEmoji: '🇦🇷', travelTime: 189,
      items: [
        { itemName: 'Monkey Plushie', buyPrice: 400,   capacity: 400  },
        { itemName: 'Ceibo Flower',   buyPrice: 500,   capacity: 1000 },
        { itemName: 'Tear Gas',       buyPrice: 15000, capacity: 500  },
        { itemName: 'LSD',            buyPrice: 150,   capacity: 100  },
      ]
    },
    {
      name: 'Switzerland', code: 'swi', flagEmoji: '🇨🇭', travelTime: 169,
      items: [
        { itemName: 'Chamois Plushie', buyPrice: 400,   capacity: 400  },
        { itemName: 'Edelweiss',       buyPrice: 900,   capacity: 1000 },
        { itemName: 'Flash Grenade',   buyPrice: 12000, capacity: 500  },
        { itemName: 'LSD',             buyPrice: 150,   capacity: 100  },
      ]
    },
    {
      name: 'Japan', code: 'jap', flagEmoji: '🇯🇵', travelTime: 225,
      items: [
        { itemName: 'Cherry Blossom', buyPrice: 500, capacity: 1000 },
        { itemName: 'Xanax',          buyPrice: 750, capacity: 100  },
        { itemName: 'Opium',          buyPrice: 75,  capacity: 100  },
      ]
    },
    {
      name: 'China', code: 'chi', flagEmoji: '🇨🇳', travelTime: 219,
      items: [
        { itemName: 'Panda Plushie', buyPrice: 400,  capacity: 400  },
        { itemName: 'Peony',         buyPrice: 5000, capacity: 1000 },
        { itemName: 'LSD',           buyPrice: 150,  capacity: 100  },
        { itemName: 'Opium',         buyPrice: 75,   capacity: 100  },
      ]
    },
    {
      name: 'UAE', code: 'uae', flagEmoji: '🇦🇪', travelTime: 259,
      items: [
        { itemName: 'Camel Plushie',     buyPrice: 14000, capacity: 400  },
        { itemName: 'Tribulus Omanense', buyPrice: 6000,  capacity: 1000 },
      ]
    },
    {
      name: 'South Africa', code: 'saf', flagEmoji: '🇿🇦', travelTime: 297,
      items: [
        { itemName: 'Lion Plushie',   buyPrice: 400,  capacity: 400  },
        { itemName: 'African Violet', buyPrice: 2000, capacity: 1000 },
        { itemName: 'Xanax',          buyPrice: 750,  capacity: 100  },
        { itemName: 'LSD',            buyPrice: 150,  capacity: 100  },
        { itemName: 'Opium',          buyPrice: 75,   capacity: 100  },
      ]
    },
  ];

  // Resolved at runtime: { 'Xanax': 206, 'LSD': 197, ... }
  let travelItemIdMap = {};

  // Flight type multipliers (applied to base one-way travel time)
  const FLIGHT_MULTIPLIERS = {
    economy:  1.0,
    airstrip: 0.7,
    business: 0.5,
    wlt:      0.5,
  };

  function getFlightMultiplier() { return FLIGHT_MULTIPLIERS[settings.flightType] ?? 1.0; }

  function getAdjustedTravelTime(baseMinutes) { return Math.round(baseMinutes * getFlightMultiplier()); }

  function resolveTravelItemIds(tornItems) {
    const needed = new Set(
      COUNTRIES.flatMap(c => c.items.map(i => i.itemName.toLowerCase()))
    );
    travelItemIdMap = {};
    for (const [idStr, item] of Object.entries(tornItems)) {
      if (item?.name && needed.has(item.name.toLowerCase())) { travelItemIdMap[item.name] = parseInt(idStr); }
    }
  }

  function calcTravelProfit(country, marketPrices, yataStock, carryCapacity) {
    const adjustedOneWay = getAdjustedTravelTime(country.travelTime);
    const roundTripHours = (adjustedOneWay * 2) / 60;
    let bestItem = null, bestProfit = -Infinity;
    for (const item of country.items) {
      // Resolve ID from name at runtime
      const id = travelItemIdMap[item.itemName];
      if (!id) continue;
      const sellPrice = marketPrices[id] ?? 0;
      if (!sellPrice) continue;
      // Deduct 5% Torn sales tax from sell price
      const netSellPrice = Math.round(sellPrice * 0.95);
      const profitPerItem = netSellPrice - item.buyPrice;
      if (profitPerItem <= 0) continue;
      const stockLevel = yataStock?.[country.code]?.[id] ?? 1.0;
      const actualCap  = Math.min(Math.floor(carryCapacity * stockLevel), item.capacity, carryCapacity);
      const pph = (profitPerItem * actualCap) / roundTripHours;
      if (pph > bestProfit) {
        bestProfit = pph;
        bestItem = { ...item, id, sellPrice, netSellPrice, profitPerItem, actualCap, stockLevel,
          stockConf: yataStock?.[country.code] !== undefined ? 'yata' : 'assumed' };
      }
    }
    return {
      country: country.name, code: country.code, flagEmoji: country.flagEmoji,
      travelTime: country.travelTime, roundTripHours,
      profitPerHour: bestProfit > 0 ? Math.round(bestProfit) : 0,
      bestItem, viable: bestProfit > 0
    };
  }

  function rankTravelDestinations(marketPrices, yataStock, carryCapacity) {
    return COUNTRIES
      .map(c => calcTravelProfit(c, marketPrices, yataStock, carryCapacity))
      .filter(r => r.viable)
      .sort((a, b) => b.profitPerHour - a.profitPerHour);
  }

  function formatPPH(pph) {
    if (pph >= 1_000_000) return `$${(pph/1_000_000).toFixed(1)}M/hr`;
    if (pph >= 1_000)     return `$${Math.round(pph/1_000)}K/hr`;
    return `$${pph}/hr`;
  }

  // Weapon type classification helper
  function classifyWeaponType(name, apiType) {
    const n = (name || '').toLowerCase();
    const t = (apiType || '').toLowerCase();
    // All comparisons lowercased — Torn is inconsistent with capitalisation
    if (t === 'melee' || t === 'piercing' || t === 'slashing' || t === 'clubbing' || t === 'mechanical') return 'Melee';
    if (t === 'heavy artillery') return 'Heavies';
    if (t === 'shotgun' || t === 'rifle' || t === 'machine gun') return 'Shotgun/Rifle';
    if (t === 'pistol' || t === 'smg') return 'Pistol/SMG';
    if (t === 'armor' || t === 'armour') return 'Armour';
    if (n.includes('helmet') || n.includes('vest') || n.includes('boots') || n.includes('gloves') || n.includes('suit')) return 'Armour';
    return null;
  }

  // Canonical RW item type check — case-insensitive to handle Torn API inconsistencies
  // Torn returns: 'Rifle', 'SMG', 'Shotgun', 'Pistol', 'Machine gun', 'Heavy artillery'
  // Melee subtypes: 'Piercing', 'Slashing', 'Clubbing', 'Mechanical'
  const RW_WEAPON_TYPE_LOWER = new Set([
    'melee', 'piercing', 'slashing', 'clubbing', 'mechanical',
    'pistol', 'smg', 'shotgun', 'rifle', 'machine gun', 'heavy artillery',
  ]);
  const RW_ARMOR_TYPE_LOWER = new Set(['armor', 'armour']);
  const RW_ARMOR_SETS = ['EOD','Sentinel','Vanguard','Dune','Delta','Marauder','Riot','Assault','Hazmat'];

  function isRWItem(name, type) {
    if (!name) return false;
    // Check hardcoded weapon name list first — most reliable
    if (RW_KNOWN_WEAPONS.has(name)) return true;
    // Check type string (case-insensitive)
    if (type) {
      const tl = type.toLowerCase();
      if (RW_WEAPON_TYPE_LOWER.has(tl)) return true;
      if (RW_ARMOR_TYPE_LOWER.has(tl))  return true;
    }
    // Check armor set names
    if (RW_ARMOR_SETS.some(s => name.includes(s))) return true;
    return false;
  }

  // Complete hardcoded list of known Torn ranked war weapons
  // Source: torn.bzimor.dev + wiki.torn.com/wiki/Weapon (May 2026)
  // Used as fallback when API type strings are unreliable
  const RW_KNOWN_WEAPONS = new Set([
    // Rifles
    'AK-47','ArmaLite M-15A4','Enfield SA-80','Gold Plated AK-47','Heckler & Koch SL8',
    'M16 A2 Rifle','M4A1 Colt Carbine','SIG 552','SKS Carbine','Steyr AUG',
    'Swiss Army SG 550','Tavor TAR-21','Vektor CR-21','XM8 Rifle',
    // SMGs
    'AK74u','BT MP9','Bushmaster Carbon 15','MP 40','MP5-Navy','MP5k',
    'P90','Pink Mac-10','Skorpion','Thompson','TMP','Type 21s','Uzi',
    // Shotguns
    'Benelli M4 Super','Ithaca 37','Jackhammer','Sawed-Off Shotgun','SPAS-12',
    // Pistols
    'Beretta 92FS','Cobra Derringer','Desert Eagle','Dual 96G Berettas',
    'Fiveseven','Flare Gun','Glock 18','Lorcin380','Luger','M-9 USP',
    'Magnum','QSZ-92','Raven MP25','Ruger 22/45','Ruger 57',
    'S&W M29','S&W Revolver','Springfield 1911-A1','Taurus',
    // Machine Guns
    'M249 PARA LMG','Negev NG-5',
    // Heavy Artillery
    'Anti-Tank Missile Launcher','Flamethrower','Milkor MGL','Minigun',
    'RPG Launcher','SMAW Launcher',
    // Melee — Piercing
    'Dagger','DBK','Dual Bladed Katars','Harpoon','Kitchen Knife',
    'Macana','Swiss Army Knife',
    // Melee — Slashing
    'Guandao','Katana','Kukri','Machete',
    // Melee — Clubbing
    'Baseball Bat','Bo Staff','Dual Hammers','Flail','Metal Nunchucks',
    'Wushu Double Axes','Wooden Nunchaku',
    // Mechanical
    'Chainsaw','Taser',
  ]);

  // Ranked war weapon bonuses — community verified (May 2026)
  // Source: wiki.torn.com/wiki/Weapon_Bonus + community guides
  const RW_BONUSES = {
    // Bonuses that can appear on ALL ranged weapons (rifle, SMG, pistol, shotgun, MG, heavy)
    ranged: [
      'Assassinate','Bloodlust','Conserve','Cripple','Deadeye',
      'Demoralize','Empower','Execute','Expose','Freeze',
      'Frenzy','Fury','Motivation','Penetrate','Powerful',
      'Puncture','Quicken','Rage','Revitalize','Slow',
      'Specialist','Stun','Sure Shot','Warlord','Weaken',
    ],
    melee: [
      'Achilles','Berserk','Bleed','Bloodlust','Crushing',
      'Empower','Execute','Freeze','Frenzy','Fury',
      'Home Run','Lacerate','Motivation','Parry','Powerful',
      'Quicken','Rage','Revitalize','Slow','Warlord','Weaken',
    ],
    // Shotgun-only extras (on top of ranged)
    shotgun_extra: ['Spray'],
    // SMG-only extras (dual SMGs)
    smg_extra: ['Spray'],
    // Armour bonuses
    armour: [
      'Block','Cushion','Durable','Fortify','Guard',
      'Parry','Reflect','Resilient','Shield','Sturdy',
    ],
  };

  function getBonusesForType(weaponType) {
    if (!weaponType) return [];
    const wt = weaponType.toLowerCase();
    if (wt === 'armour' || wt === 'armor') return [...RW_BONUSES.armour].sort();
    if (wt === 'melee') return [...RW_BONUSES.melee].sort();
    // All ranged types — Pistol/SMG, Shotgun/Rifle, Heavies map here
    let bonuses = [...RW_BONUSES.ranged];
    if (wt.includes('shotgun')) bonuses = [...bonuses, ...RW_BONUSES.shotgun_extra];
    if (wt === 'smg' || wt === 'pistol/smg' || wt.includes('smg')) bonuses = [...bonuses, ...RW_BONUSES.smg_extra];
    return [...new Set(bonuses)].sort();
  }

  function store(key, val) {
    try { GM_setValue(SCRIPT_KEY + key, JSON.stringify(val)); } catch(e) {}
  }

  function load(key, def) {
    try {
      const v = GM_getValue(SCRIPT_KEY + key);
      if (v === undefined || v === null || v === '') return def;
      const parsed = JSON.parse(v);
      // Sanity check — if type doesn't match default, return default
      if (Array.isArray(def) && !Array.isArray(parsed)) return def;
      if (def !== null && typeof def === 'object' && !Array.isArray(def) && typeof parsed !== 'object') return def;
      return parsed;
    } catch(e) {
      // Corrupted storage — clear it and return default
      try { GM_setValue(SCRIPT_KEY + key, JSON.stringify(def)); } catch(e2) {}
      return def;
    }
  }

  let settings = load('settings', {
    apiKey: '',
    minProfit: 0,
    maxBudget: 0,
    selectedTimeframe: '1D',
    selectedCategory: 'All',
    sortBy: 'profit_pct',
    activeTab: 'all',
    carryCapacity: 10,
    flightType: 'economy',      // economy | airstrip | business | wlt
    marketPollSec: 60,          // how often to fetch item prices (seconds)
    statsPollSec:  30,          // how often to fetch bars/cooldowns (seconds)
    alertOnDrugClear: false,    // only alert when drug cooldown is clear
    alertOnBoosterClear: false, // only alert when booster cooldown is clear
    alertRequireStock: false,   // only alert when YATA confirms stock
    minimized: false,
    posX: null,
    posY: null,
    fabX: null,
    fabY: null,
  });

  function saveSettings() { store('settings', settings); }

  // Structure: { itemId: [ { ts, price, yataPrice }, ... ] }
  let priceHistory = load('priceHistory', {});

  function appendHistory(itemId, tornPrice, yataPrice) {
    if (!priceHistory[itemId]) priceHistory[itemId] = [];
    const now = Date.now();
    priceHistory[itemId].push({ ts: now, price: tornPrice, yataPrice });
    priceHistory[itemId] = thinHistory(priceHistory[itemId], now);
  }

  function thinHistory(snapshots, now) {
    if (!snapshots.length) return snapshots;
    // Work through snapshots oldest to newest, keeping one per resolution bucket
    // for each age tier. Always keep the most recent snapshot.
    const result = [];
    // Track the last kept timestamp per tier slot
    const lastKept = {};

    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      const isLast = i === snapshots.length - 1;
      if (isLast) { result.push(s); break; } // always keep latest

      const age = now - s.ts;
      const tier = HISTORY_TIERS.find(t => age <= t.maxAgeMs) ?? HISTORY_TIERS[HISTORY_TIERS.length - 1];
      const bucket = Math.floor(s.ts / tier.resolutionMs);
      const key = tier.resolutionMs + '_' + bucket;

      if (!lastKept[key]) { result.push(s);
        lastKept[key] = true; }
      // Otherwise skip — a snapshot for this time bucket already kept
    }
    return result;
  }

  // Run thinning on all existing history on startup — cleans up old flat data
  // and compacts history that was stored before tiered thinning was introduced
  function thinAllHistory() {
    const now = Date.now();
    let changed = false;
    for (const [idStr, hist] of Object.entries(priceHistory)) {
      if (!hist.length) continue;
      const thinned = thinHistory(hist, now);
      if (thinned.length !== hist.length) { priceHistory[idStr] = thinned;
        changed = true; }
    }
    if (changed) saveHistory();
  }

  function saveHistory() { store('priceHistory', priceHistory); }

  let itemMeta = load('itemMeta', {}); // { id: { name, type, image } }

  let lastYataPrices = {};
  let analysisCache  = [];
  let watchlist      = new Set(load('watchlist', []));
  let myBattleStats    = load('myBattleStats', null);
  let statHistory      = load('statHistory', []);         // [ { ts, str, def, spd, dex, ts_total } ]
  // Player cache persisted to GM storage — survives page loads
  const PLAYER_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

  function loadPlayerCache() {
    try {
      const raw = load('playerCache', {});
      const now = Date.now();
      // Prune expired entries
      const pruned = {};
      for (const [id, entry] of Object.entries(raw)) {
        if (entry.cachedAt && (now - entry.cachedAt) < PLAYER_CACHE_TTL) { pruned[id] = entry; }
      }
      return pruned;
    } catch(e) { return {}; }
  }

  let playerCache = loadPlayerCache();

  function savePlayerCache() {
    // Only save up to 500 entries to avoid storage bloat
    const entries = Object.entries(playerCache);
    if (entries.length > 500) {
      // Keep newest 500
      const sorted = entries.sort((a,b) => (b[1].cachedAt||0) - (a[1].cachedAt||0)).slice(0, 500);
      playerCache = Object.fromEntries(sorted);
    }
    store('playerCache', playerCache);
  }
  const MAX_STAT_HISTORY = 100;

  function saveStatHistory() { store('statHistory', statHistory); }
  function saveMyBattleStats() { store('myBattleStats', myBattleStats); }
  let travelRanking  = [];
  let yataStockCache = null;

  function saveWatchlist() { store('watchlist', [...watchlist]); }

  // ── Session tracker ───────────────────────────────────────────────────────
  let sessionStart      = Date.now();
  let sessionStartPrices = {}; // { itemId: price at session start }
  let sessionProfit     = 0;

  // ── Onboarding ────────────────────────────────────────────────────────────
  let onboardingDone  = load('onboardingDone', false);
  thinAllHistory()
  let bbPerDollar      = load('bbPerDollar', 7000000);
  let userBBBalance    = 0;
  let warItemStats     = load('warItemStats', {});
  let userInventory   = {};  // { itemId: { name, quantity, uid } } — refreshed each poll  // { itemName: {damage,accuracy,armor,stealth,exp} }
  let quickItems      = load('quickItems',   []);  // [{ name }] — saved items for quick-use bar

  try { if (Object.keys(itemMeta).length === 0) {
    for (const name of RW_KNOWN_WEAPONS) {
      itemMeta['rw_' + name.replace(/\s+/g, '_')] = { name, type: 'Unknown', market_value: 0, temp: true };
    }
  } } catch(e) {}

  // ── Travel alert tracking ─────────────────────────────────────────────────
  let lastTopTravelCode = load('lastTravelCode', null);
  let lastTopTravelPPH  = load('lastTravelPPH',  0);

  // ── Tooltip state ─────────────────────────────────────────────────────────
  const TOOLTIPS = {
    signal:     'Signal shows the price trend direction.\nBUY = rising 5%+. HOLD = mild uptrend. WATCH = volatile, no clear direction. SELL = falling 8%+.',
    confidence: 'Confidence dots show how strong the signal is.\n● ● ● = strong trend, lots of data.\n● ● ○ = moderate.\n● ○ ○ = early/thin data.',
    pph:        'Profit Per Hour — estimated $ earned per hour of round-trip travel, after 5% sales tax.',
    stock:      'YATA ✓ = live crowd-sourced stock data from yata.life.\n~stock = no data, assuming full stock (optimistic).',
    change:     'Price change % over your selected timeframe.\nOrange = price rising (hot). Teal = falling (cold).',
    dataAge:    'How long ago prices were last fetched. Green = fresh. Yellow = >5min old. Red = >15min.',
  };
  let alertActive = false, pollingTimer = null, statsTimer = null, uiBuilt = false;

  async function fetchMyBattleStats(apiKey) {
    try {
      const data = await apiGet(
        `https://api.torn.com/user/?selections=battlestats,bars,cooldowns,profile&key=${apiKey}&comment=TEEM`
      );
      if (data.error) return null;

      const bs = {
        str:       data.strength       ?? 0,
        def:       data.defense        ?? 0,
        spd:       data.speed          ?? 0,
        dex:       data.dexterity      ?? 0,
        strMod:    data.strength_modifier   ?? 100,
        defMod:    data.defense_modifier    ?? 100,
        spdMod:    data.speed_modifier      ?? 100,
        dexMod:    data.dexterity_modifier  ?? 100,
        timestamp: Date.now(),
        // bars
        energy:    data.energy?.current    ?? 0,
        energyMax: data.energy?.maximum    ?? 150,
        nerve:     data.nerve?.current     ?? 0,
        nerveMax:  data.nerve?.maximum     ?? 25,
        happy:     data.happy?.current     ?? 0,
        happyMax:  data.happy?.maximum     ?? 100,
        life:      data.life?.current      ?? 0,
        lifeMax:   data.life?.maximum      ?? 100,
        // cooldowns
        drugCd:    data.cooldowns?.drug    ?? 0,
        boosterCd: data.cooldowns?.booster ?? 0,
        medicalCd: data.cooldowns?.medical ?? 0,
        // profile
        name:      data.name     ?? '',
        level:     data.level    ?? 0,
        playerId:  data.player_id ?? 0,
      };
      bs.total = bs.str + bs.def + bs.spd + bs.dex;

      myBattleStats = bs;
      saveMyBattleStats();

      // Record in history
      statHistory.push({ ts: Date.now(), str: bs.str, def: bs.def, spd: bs.spd, dex: bs.dex, total: bs.total });
      if (statHistory.length > MAX_STAT_HISTORY) statHistory = statHistory.slice(-MAX_STAT_HISTORY);
      saveStatHistory();

      return bs;
    } catch(e) {
      console.warn('[TEEM] Battlestats fetch failed:', e.message);
      return null;
    }
  }

  // Fetch spy data for a player from TornStats
  async function fetchTornStatsSpy(tsKey, playerId) {
    try {
      const data = await apiGet(`https://www.tornstats.com/api/v2/${tsKey}/spy/user/${playerId}`);
      if (!data?.status || !data?.spy) return null;
      const s = data.spy;
      return {
        source:    'TornStats',
        str:       s.strength    ?? 0,
        def:       s.defense     ?? 0,
        spd:       s.speed       ?? 0,
        dex:       s.dexterity   ?? 0,
        total:     s.total       ?? (s.strength + s.defense + s.speed + s.dexterity),
        timestamp: s.timestamp   ?? 0,
        name:      s.name        ?? '',
      };
    } catch(e) { return null; }
  }

  // Fetch spy data from YATA
  async function fetchYataSpy(playerId) {
    try {
      const yataKey = load('yataKey', '');
      const url = yataKey
        ? `https://yata.life/api/v1/spies/${playerId}/?format=json&key=${yataKey}`
        : `https://yata.life/api/v1/spies/${playerId}/?format=json`;
      const data = await apiGet(url);
      if (!data || data.error) return null;
      const s = data;
      return {
        source:    'YATA',
        str:       s.strength  ?? 0,
        def:       s.defense   ?? 0,
        spd:       s.speed     ?? 0,
        dex:       s.dexterity ?? 0,
        total:     (s.strength ?? 0) + (s.defense ?? 0) + (s.speed ?? 0) + (s.dexterity ?? 0),
        timestamp: s.timestamp ?? 0,
        name:      s.name      ?? '',
      };
    } catch(e) { return null; }
  }

  // Estimate stat range from level (rough heuristic based on community data)
  // Returns { low, mid, high } as total battle stats
  function estimateFromLevel(level) {
    // Level is a very poor proxy for battle stats in Torn.
    // Level = attacks done. Stats = gym energy spent. Almost independent.
    // Ranges are intentionally wide — add TornStats/YATA for real data.
    const brackets = [
      { maxLvl:   5, low:    1e3,  high:   500e3  },
      { maxLvl:  15, low:   10e3,  high:     5e6  },
      { maxLvl:  30, low:   50e3,  high:    50e6  },
      { maxLvl:  50, low:  100e3,  high:   200e6  },
      { maxLvl: 100, low:  500e3,  high:     1e9  },
      { maxLvl: Infinity, low: 1e6, high:  200e9  },
    ];
    const b = brackets.find(br => level <= br.maxLvl) ?? brackets[brackets.length - 1];
    return { low: b.low, high: b.high };
  }

  function formatStatShort(n) {
    if (!n) return '?';
    if (n >= 1e12) return (n/1e12).toFixed(1) + 'T';
    if (n >= 1e9)  return (n/1e9).toFixed(1)  + 'B';
    if (n >= 1e6)  return (n/1e6).toFixed(1)  + 'M';
    if (n >= 1e3)  return (n/1e3).toFixed(1)  + 'K';
    return n.toString();
  }

  function formatCooldown(secs) {
    if (!secs || secs <= 0) return null;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // ── Carry capacity auto-detect ───────────────────────────────────────────
  async function detectCarryCapacity(apiKey) {
    try {
      const data = await apiGet(
        `https://api.torn.com/user/?selections=education,inventory,faction,perks&key=${apiKey}&comment=TEEM`
      );
      if (data.error) return null;

      let base = 5;

      // Business Class / WLT / Airstrip upgrade gives 15 base
      // Check inventory for suitcases
      const inv = Object.values(data.inventory ?? {});
      const hasMedSuitcase  = inv.some(i => i.name === 'Medium Suitcase');
      const hasLargeSuitcase = inv.some(i => i.name === 'Large Suitcase');

      // Suitcase bonuses (only the largest applies)
      if (hasLargeSuitcase) base += 4;
      else if (hasMedSuitcase) base += 2;

      // Faction Excursion special — up to +10
      const factionPerks = data.faction_perks ?? data.perks?.faction ?? [];
      const excursion = factionPerks.find?.(p =>
        typeof p === 'string' ? p.toLowerCase().includes('excursion') :
        (p.name ?? '').toLowerCase().includes('excursion')
      );
      if (excursion) {
        const match = (excursion.value ?? excursion.toString()).match(/\+?(\d+)/);
        if (match) base += Math.min(10, parseInt(match[1]));
      }

      // Lingerie Store 3* job special (+2) — can't reliably detect, skip
      // Cruise Line Agency 3*/10* (+2/+3) — same

      return Math.max(5, base);
    } catch(e) {
      return null;
    }
  }

  // ── Styles ────────────────────────────────────────────────────────────────────
  GM_addStyle(`
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600&display=swap');#tmit-fab{position:fixed;bottom:28px;right:28px;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#2d1b69,#0d0010);border:2px solid #c9a227;box-shadow:0 0 14px rgba(201,162,39,0.5),0 4px 24px rgba(0,0,0,0.8);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;z-index:999999;transition:all 0.3s ease;user-select:none;}#tmit-fab:hover{transform:scale(1.1);box-shadow:0 0 26px rgba(201,162,39,0.8),0 4px 28px rgba(0,0,0,0.9);}#tmit-fab.tmit-alert{animation:tmit-pulse 1.4s ease-in-out infinite;border-color:#ffe066;}@keyframes tmit-pulse{0%{box-shadow:0 0 0 0 rgba(255,224,102,0.9),0 4px 20px rgba(0,0,0,0.7);}60%{box-shadow:0 0 0 18px rgba(255,224,102,0),0 4px 20px rgba(0,0,0,0.7);}100%{box-shadow:0 0 0 0 rgba(255,224,102,0),0 4px 20px rgba(0,0,0,0.7);}}#tmit-fab .tmit-alert-dot{display:none;position:absolute;top:2px;right:2px;width:12px;height:12px;background:#ff4d4d;border-radius:50%;border:2px solid #0d0010;animation:tmit-dotpop 0.3s ease;}#tmit-fab.tmit-alert .tmit-alert-dot{display:block;}@keyframes tmit-dotpop{from{transform:scale(0);}to{transform:scale(1);}}#tmit-panel{position:fixed;bottom:90px;right:28px;width:480px;max-height:620px;background:linear-gradient(180deg,rgba(45,27,105,0.97) 0%,rgba(18,6,40,0.99) 40%,rgba(5,2,12,1) 100%);border:1px solid #c9a227;border-top:3px solid #c9a227;border-radius:12px;box-shadow:0 0 0 1px rgba(0,0,0,0.8),0 0 50px rgba(201,162,39,0.12),0 24px 80px rgba(0,0,0,0.9),inset 0 1px 0 rgba(201,162,39,0.15);z-index:999998;display:flex;flex-direction:column;overflow:hidden;font-family:'Inter',sans-serif;color:#e8dff5;transition:opacity 0.2s,transform 0.2s;}#tmit-panel.tmit-hidden{opacity:0;pointer-events:none;transform:translateY(12px);}.tmit-header{background:linear-gradient(90deg,rgba(45,27,105,1) 0%,rgba(20,10,50,1) 60%,rgba(8,4,20,1) 100%);border-bottom:1px solid rgba(201,162,39,0.35);padding:11px 16px;display:flex;align-items:center;justify-content:space-between;cursor:move;flex-shrink:0;position:relative;}.tmit-header::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent 0%,#c9a227 30%,#ffe066 50%,#c9a227 70%,transparent 100%);opacity:0.7;}.tmit-title{font-family:'Cinzel',serif;font-size:14px;font-weight:700;color:#c9a227;letter-spacing:0.06em;display:flex;align-items:center;gap:8px;text-shadow:0 0 12px rgba(201,162,39,0.4);}.tmit-title-icon{font-size:16px;}.tmit-header-right{display:flex;align-items:center;gap:8px;}.tmit-status-pill{font-size:10px;padding:2px 8px;border-radius:20px;background:rgba(201,162,39,0.08);border:1px solid rgba(201,162,39,0.25);color:#c9a227;font-family:monospace;}.tmit-status-pill.tmit-ok{border-color:rgba(80,220,130,0.4);color:#50dc82;background:rgba(80,220,130,0.07);}.tmit-status-pill.tmit-live{border-color:rgba(255,200,50,0.5);color:#ffe066;background:rgba(255,200,50,0.07);}.tmit-status-pill.tmit-err{border-color:rgba(255,80,80,0.4);color:#ff6060;background:rgba(255,80,80,0.07);}.tmit-btn-close,.tmit-btn-settings-toggle,.tmit-btn-refresh{background:rgba(0,0,0,0.3);border:1px solid rgba(201,162,39,0.2);color:#7a6020;border-radius:4px;width:24px;height:24px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;padding:0;line-height:1;}.tmit-btn-close:hover,.tmit-btn-settings-toggle:hover,.tmit-btn-refresh:hover{border-color:#c9a227;color:#ffe066;background:rgba(201,162,39,0.1);box-shadow:0 0 8px rgba(201,162,39,0.2);}.tmit-tab-bar{display:flex;border-bottom:1px solid rgba(201,162,39,0.2);flex-shrink:0;background:rgba(0,0,0,0.4);}.tmit-tab{flex:1;padding:7px 0;font-size:11px;font-weight:600;text-align:center;cursor:pointer;color:#4a3a6a;border-bottom:2px solid transparent;transition:all 0.15s;letter-spacing:0.04em;user-select:none;}.tmit-tab:hover{color:#c9a227;}.tmit-tab.tmit-tab-active{color:#ffe066;border-bottom-color:#c9a227;background:rgba(201,162,39,0.04);}.tmit-tab .tmit-tab-count{display:inline-block;margin-left:4px;font-size:9px;background:rgba(201,162,39,0.15);color:#c9a227;border-radius:8px;padding:0 5px;font-family:monospace;vertical-align:middle;}.tmit-tab.tmit-tab-active .tmit-tab-count{background:rgba(201,162,39,0.3);}.tmit-controls{padding:7px 12px;border-bottom:1px solid rgba(201,162,39,0.1);display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex-shrink:0;background:rgba(0,0,0,0.35);}.tmit-timeframe-group,.tmit-filter-group{display:flex;gap:3px;}.tmit-tf-btn{background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.15);color:#6a5a8a;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;font-family:monospace;}.tmit-tf-btn:hover{border-color:#c9a227;color:#c9a227;}.tmit-tf-btn.tmit-active{background:rgba(201,162,39,0.15);border-color:#c9a227;color:#ffe066;box-shadow:0 0 6px rgba(201,162,39,0.2);}.tmit-divider{width:1px;height:20px;background:rgba(201,162,39,0.15);margin:0 2px;}.tmit-select{background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.18);color:#c9a227;border-radius:4px;padding:3px 6px;font-size:11px;cursor:pointer;outline:none;font-family:'Inter',sans-serif;}.tmit-select option{background:#0d0520;color:#e8dff5;}.tmit-search{flex:1;min-width:80px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.18);border-radius:4px;color:#e8dff5;font-size:11px;padding:3px 8px;outline:none;font-family:'Inter',sans-serif;}.tmit-search::placeholder{color:#3a2a5a;}.tmit-search:focus{border-color:rgba(201,162,39,0.45);}.tmit-filter-row{padding:5px 12px;border-bottom:1px solid rgba(201,162,39,0.08);display:flex;gap:8px;align-items:center;flex-shrink:0;background:rgba(0,0,0,0.3);}.tmit-filter-label{font-size:10px;color:#4a3a6a;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap;}.tmit-input-sm{background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.18);border-radius:4px;color:#e8dff5;font-size:11px;padding:3px 8px;width:100px;outline:none;font-family:monospace;}.tmit-input-sm:focus{border-color:rgba(201,162,39,0.45);}.tmit-col-headers{display:grid;grid-template-columns:1fr 90px 90px 80px;padding:5px 12px;border-bottom:1px solid rgba(201,162,39,0.12);flex-shrink:0;background:rgba(0,0,0,0.5);}.tmit-col-hdr{font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#4a3a6a;cursor:pointer;user-select:none;transition:color 0.15s;}.tmit-col-hdr:hover{color:#c9a227;}.tmit-col-hdr.tmit-sorted{color:#c9a227;}.tmit-col-hdr:not(:first-child){text-align:right;}.tmit-list{overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:rgba(201,162,39,0.25) transparent;}.tmit-list::-webkit-scrollbar{width:4px;}.tmit-list::-webkit-scrollbar-track{background:transparent;}.tmit-list::-webkit-scrollbar-thumb{background:rgba(201,162,39,0.25);border-radius:2px;}.tmit-tab-panel{scrollbar-width:thin;scrollbar-color:rgba(160,80,255,0.5) rgba(255,255,255,0.04);}.tmit-tab-panel::-webkit-scrollbar{width:5px;}.tmit-tab-panel::-webkit-scrollbar-track{background:rgba(255,255,255,0.04);border-radius:3px;}.tmit-tab-panel::-webkit-scrollbar-thumb{background:rgba(160,80,255,0.5);border-radius:3px;}.tmit-tab-panel::-webkit-scrollbar-thumb:hover{background:rgba(160,80,255,0.8);}.tmit-settings-panel{scrollbar-width:thin;scrollbar-color:rgba(160,80,255,0.5) rgba(255,255,255,0.04);}.tmit-settings-panel::-webkit-scrollbar{width:5px;}.tmit-settings-panel::-webkit-scrollbar-track{background:rgba(255,255,255,0.04);border-radius:3px;}.tmit-settings-panel::-webkit-scrollbar-thumb{background:rgba(160,80,255,0.5);border-radius:3px;}.tmit-settings-panel::-webkit-scrollbar-thumb:hover{background:rgba(160,80,255,0.8);}.tmit-item-row{display:grid;grid-template-columns:1fr 90px 90px 80px;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.03);align-items:center;transition:background 0.12s;cursor:default;position:relative;}.tmit-item-row:hover{background:rgba(201,162,39,0.05);}.tmit-item-row.tmit-hot{background:linear-gradient(90deg,rgba(232,98,26,0.08) 0%,transparent 100%);border-left:2px solid #e8621a;}.tmit-item-row.tmit-hot::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#ffe066,#e8621a,#8b2500);box-shadow:0 0 6px rgba(232,98,26,0.6);}.tmit-item-row.tmit-hot:hover{background:linear-gradient(90deg,rgba(232,98,26,0.13) 0%,transparent 100%);}.tmit-item-row.tmit-hot-big{background:linear-gradient(90deg,rgba(232,98,26,0.14) 0%,transparent 70%);border-left:2px solid #ff6a00;animation:tmit-ember 2s ease-in-out infinite alternate;}.tmit-item-row.tmit-hot-big::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#fff0a0,#ff6a00,#8b2500);box-shadow:0 0 10px rgba(255,106,0,0.8);}@keyframes tmit-ember{from{background:linear-gradient(90deg,rgba(232,98,26,0.10) 0%,transparent 70%);}to{background:linear-gradient(90deg,rgba(232,98,26,0.20) 0%,transparent 70%);}}.tmit-item-row.tmit-icy{background:linear-gradient(90deg,rgba(61,214,200,0.07) 0%,transparent 100%);border-left:2px solid #3dd6c8;}.tmit-item-row.tmit-icy::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#e0ffff,#3dd6c8,#0a5a54);box-shadow:0 0 6px rgba(61,214,200,0.5);}.tmit-item-row.tmit-icy:hover{background:linear-gradient(90deg,rgba(61,214,200,0.11) 0%,transparent 100%);}.tmit-item-row.tmit-icy-big{background:linear-gradient(90deg,rgba(61,214,200,0.12) 0%,transparent 70%);border-left:2px solid #00e5ff;animation:tmit-frost 2.5s ease-in-out infinite alternate;}.tmit-item-row.tmit-icy-big::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#ffffff,#00e5ff,#005566);box-shadow:0 0 10px rgba(0,229,255,0.7);}@keyframes tmit-frost{from{background:linear-gradient(90deg,rgba(61,214,200,0.08) 0%,transparent 70%);}to{background:linear-gradient(90deg,rgba(61,214,200,0.16) 0%,transparent 70%);}}.tmit-item-row.tmit-pinned{border-left:2px solid #c9a227;background:rgba(201,162,39,0.04);}.tmit-item-name{font-size:12px;font-weight:500;color:#d8c8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:8px;}.tmit-item-name .tmit-spike-icon{font-size:10px;margin-right:4px;}.tmit-item-type{font-size:9px;color:#3a2a5a;margin-top:1px;}.tmit-price{font-family:monospace;font-size:11px;color:#9080b0;text-align:right;}.tmit-change{font-family:monospace;font-size:12px;font-weight:700;text-align:right;}.tmit-change.up{color:#e8621a;text-shadow:0 0 8px rgba(232,98,26,0.5);}.tmit-change.down{color:#3dd6c8;text-shadow:0 0 8px rgba(61,214,200,0.4);}.tmit-change.flat{color:#3a2a5a;}.tmit-signal{text-align:right;}.tmit-signal-badge{display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.06em;padding:2px 6px;border-radius:3px;text-transform:uppercase;}.tmit-signal-badge.BUY{background:rgba(232,98,26,0.18);color:#ff8c42;border:1px solid rgba(232,98,26,0.4);text-shadow:0 0 6px rgba(232,98,26,0.4);}.tmit-signal-badge.SELL{background:rgba(61,214,200,0.15);color:#3dd6c8;border:1px solid rgba(61,214,200,0.35);text-shadow:0 0 6px rgba(61,214,200,0.3);}.tmit-signal-badge.HOLD{background:rgba(201,162,39,0.15);color:#c9a227;border:1px solid rgba(201,162,39,0.3);}.tmit-signal-badge.WATCH{background:rgba(160,100,255,0.12);color:#b080ff;border:1px solid rgba(160,100,255,0.28);cursor:pointer;transition:all 0.2s;}.tmit-signal-badge.WATCH:hover{background:rgba(201,162,39,0.18);color:#ffe066;border-color:rgba(201,162,39,0.5);}.tmit-signal-badge.WATCH.tmit-watched{background:rgba(201,162,39,0.22);color:#ffe066;border-color:#c9a227;box-shadow:0 0 7px rgba(201,162,39,0.45);}.tmit-confidence-bar{display:flex;gap:2px;align-items:center;}.tmit-conf-dot{width:5px;height:5px;border-radius:50%;background:rgba(201,162,39,0.12);}.tmit-conf-dot.filled{background:#c9a227;box-shadow:0 0 3px rgba(201,162,39,0.4);}.tmit-state-msg{padding:32px 20px;text-align:center;color:#3a2a5a;font-size:13px;line-height:1.7;}.tmit-state-msg .tmit-state-icon{font-size:28px;margin-bottom:8px;}.tmit-settings-panel{padding:14px 16px;border-top:1px solid rgba(201,162,39,0.18);background:rgba(0,0,0,0.5);display:none;flex-shrink:0;}.tmit-settings-panel.tmit-open{display:block;}.tmit-settings-title{font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:10px;}.tmit-setting-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}.tmit-setting-row label{font-size:11px;color:#7060a0;width:100px;flex-shrink:0;}.tmit-setting-row input{flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.22);border-radius:4px;color:#e8dff5;font-size:12px;padding:5px 9px;outline:none;font-family:monospace;}.tmit-setting-row input:focus{border-color:rgba(201,162,39,0.55);}.tmit-btn-save{margin-top:8px;background:linear-gradient(90deg,#c9a227 0%,#8b6e10 50%,#c9a227 100%);background-size:200%;border:none;border-radius:5px;color:#0d0010;font-weight:700;font-size:12px;padding:6px 18px;cursor:pointer;font-family:'Inter',sans-serif;transition:background-position 0.4s,filter 0.15s;}.tmit-btn-save:hover{background-position:right;filter:brightness(1.15);}.tmit-footer{padding:5px 12px;border-top:1px solid rgba(201,162,39,0.1);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:rgba(0,0,0,0.6);}.tmit-footer-stat{font-size:9px;color:#3a2a5a;font-family:monospace;}.tmit-footer-stat span{color:#6a5a8a;}.tmit-section-title{font-family:'Cinzel',serif;font-size:11px;font-weight:700;color:#c9a227;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(201,162,39,0.2);}.tmit-war-form{margin-bottom:10px;}.tmit-form-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}.tmit-form-row label{font-size:10px;color:#6a5a8a;font-weight:600;width:120px;flex-shrink:0;text-transform:uppercase;letter-spacing:0.05em;}.tmit-form-row2{display:flex;gap:8px;margin-bottom:6px;}.tmit-form-row2 > div{flex:1;display:flex;flex-direction:column;gap:3px;}.tmit-form-row2 label{font-size:9px;color:#6a5a8a;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;}.tmit-input-full{width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.18);border-radius:4px;color:#e8dff5;font-size:11px;padding:4px 8px;outline:none;font-family:monospace;}.tmit-input-full:focus{border-color:rgba(201,162,39,0.45);}.tmit-btn-calc{margin-top:6px;background:linear-gradient(90deg,#c9a227,#8b6e10);border:none;border-radius:5px;color:#0d0010;font-weight:700;font-size:11px;padding:5px 16px;cursor:pointer;font-family:'Inter',sans-serif;transition:filter 0.15s;}.tmit-btn-calc:hover{filter:brightness(1.2);}.tmit-calc-result{background:rgba(0,0,0,0.35);border:1px solid rgba(201,162,39,0.2);border-radius:6px;padding:10px 12px;margin-top:8px;font-size:11px;line-height:1.8;}.tmit-calc-result .tmit-result-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);}.tmit-calc-result .tmit-result-row:last-child{border-bottom:none;}.tmit-result-label{color:#7a6090;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;}.tmit-result-val{color:#e8dff5;font-family:monospace;font-weight:600;}.tmit-result-val.gold{color:#ffe066;}.tmit-result-val.hot{color:#e8621a;}.tmit-result-val.icy{color:#3dd6c8;}.tmit-result-val.green{color:#50dc82;}.tmit-score-bar{display:flex;gap:3px;margin-top:6px;}.tmit-score-segment{height:6px;border-radius:2px;flex:1;background:rgba(255,255,255,0.06);transition:background 0.3s;}.tmit-score-segment.filled-hot{background:#e8621a;box-shadow:0 0 4px rgba(232,98,26,0.5);}.tmit-score-segment.filled-gold{background:#c9a227;box-shadow:0 0 4px rgba(201,162,39,0.4);}.tmit-score-segment.filled-icy{background:#3dd6c8;box-shadow:0 0 4px rgba(61,214,200,0.4);}.tmit-bb-balance-row{display:flex;align-items:center;gap:8px;margin-bottom:10px;padding:8px 10px;background:rgba(201,162,39,0.06);border:1px solid rgba(201,162,39,0.2);border-radius:6px;}.tmit-bb-bignum{font-family:'Share Tech Mono',monospace;font-size:18px;color:#ffe066;font-weight:700;text-shadow:0 0 10px rgba(255,224,102,0.4);}.tmit-war-tracker{margin-top:4px;}.tmit-war-row{display:grid;grid-template-columns:1fr 80px 80px 70px 55px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;font-size:11px;border-radius:3px;margin-bottom:1px;}.tmit-war-row:hover{background:rgba(201,162,39,0.05);}.tmit-travel-row{display:grid;grid-template-columns:24px 1fr 90px 80px 70px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;cursor:pointer;border-radius:3px;transition:background 0.12s;}.tmit-travel-row:hover{background:rgba(201,162,39,0.06);}.tmit-travel-row.rank1{border-left:2px solid #ffe066;background:rgba(201,162,39,0.05);}.tmit-travel-row.rank2{border-left:2px solid #c0c0c0;}.tmit-travel-row.rank3{border-left:2px solid #cd7f32;}.tmit-travel-flag{font-size:14px;}.tmit-travel-dest{font-size:12px;font-weight:500;color:#d8c8f0;}.tmit-travel-sub{font-size:9px;color:#4a3a6a;margin-top:1px;}.tmit-travel-pph{font-family:monospace;font-size:12px;font-weight:700;color:#e8621a;text-align:right;}.tmit-travel-pph.top{color:#ffe066;text-shadow:0 0 8px rgba(255,224,102,0.4);}.tmit-travel-time{font-family:monospace;font-size:10px;color:#6a5a8a;text-align:right;}.tmit-travel-stock{font-size:9px;text-align:right;font-family:monospace;}.tmit-travel-stock.yata{color:#50dc82;}.tmit-travel-stock.assumed{color:#4a3a6a;}.tmit-travel-detail-card{background:rgba(0,0,0,0.3);border:1px solid rgba(201,162,39,0.18);border-radius:6px;padding:10px 12px;}.tmit-bar-row{display:flex;align-items:center;gap:8px;margin-bottom:5px;}.tmit-bar-label{font-size:10px;color:#6a5a8a;font-weight:700;width:56px;flex-shrink:0;text-transform:uppercase;letter-spacing:0.05em;}.tmit-bar-track{flex:1;height:8px;background:rgba(255,255,255,0.05);border-radius:4px;overflow:hidden;}.tmit-bar-fill{height:100%;border-radius:4px;transition:width 0.4s ease;}.tmit-bar-val{font-family:monospace;font-size:10px;color:#9080b0;width:50px;text-align:right;flex-shrink:0;}.tmit-bar-mod{font-size:9px;width:32px;text-align:right;flex-shrink:0;}.teem-stat-badge{display:inline-flex;align-items:center;gap:0;margin-left:5px;padding:0;background:none;border:none;cursor:default;vertical-align:middle;white-space:nowrap;position:relative;z-index:9999;transition:gap 0.15s;}.teem-stat-badge img.teem-icon{width:14px;height:14px;border-radius:50%;opacity:0.55;transition:opacity 0.15s,transform 0.15s;flex-shrink:0;display:block;}.teem-stat-badge:hover img.teem-icon{opacity:1;transform:scale(1.15);}.teem-stat-badge .teem-badge-label{max-width:0;overflow:hidden;opacity:0;font-size:10px;font-family:monospace;font-weight:700;white-space:nowrap;transition:max-width 0.2s ease,opacity 0.15s ease,margin-left 0.15s;margin-left:0;}.teem-stat-badge:hover .teem-badge-label{max-width:80px;opacity:1;margin-left:3px;}.teem-stat-badge.spy-exact .teem-badge-label{color:#50dc82;}.teem-stat-badge.spy-range .teem-badge-label{color:#c9a227;}#teem-global-tip{display:none;position:fixed;background:#1e0f45;border:1px solid rgba(201,162,39,0.4);border-radius:8px;padding:10px 13px;font-size:11px;font-family:'Inter',sans-serif;color:#c8b8e8;white-space:pre-line;max-width:220px;line-height:1.7;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.85);pointer-events:none;}#teem-global-tip.visible{display:block;}.tmit-war-row.yellow-item{border-left:2px solid #ffe066;}#tmit-onboard{position:fixed;bottom:28px;left:28px;z-index:9999999;animation:tmit-slidein 0.4s cubic-bezier(0.16,1,0.3,1);}@keyframes tmit-slidein{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}.tmit-onboard-card{background:linear-gradient(160deg,#1e0f45 0%,#0d0520 100%);border:1px solid #c9a227;border-top:3px solid #c9a227;border-radius:12px;width:340px;padding:18px 18px 14px;box-shadow:0 0 40px rgba(201,162,39,0.18),0 16px 48px rgba(0,0,0,0.8);position:relative;}.tmit-onboard-logo{width:56px;height:56px;border-radius:50%;border:2px solid #c9a227;margin:0 auto 14px;display:block;}.tmit-onboard-title{font-family:'Cinzel',serif;font-size:18px;font-weight:700;color:#c9a227;text-align:center;margin-bottom:4px;letter-spacing:0.05em;}.tmit-onboard-subtitle{font-size:11px;color:#5a4a7a;text-align:center;margin-bottom:20px;}.tmit-onboard-step{display:none;}.tmit-onboard-step.active{display:block;}.tmit-onboard-step-title{font-size:13px;font-weight:700;color:#e8dff5;margin-bottom:8px;}.tmit-onboard-step-body{font-size:12px;color:#8a7aaa;line-height:1.7;margin-bottom:16px;}.tmit-onboard-step-body b{color:#c9a227;}.tmit-onboard-step-body code{background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.2);border-radius:3px;padding:1px 5px;font-family:monospace;font-size:11px;color:#ffe066;}.tmit-onboard-input{width:100%;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.3);border-radius:6px;color:#e8dff5;font-family:monospace;font-size:13px;padding:9px 12px;outline:none;margin-bottom:8px;}.tmit-onboard-input:focus{border-color:#c9a227;}.tmit-onboard-validate{font-size:11px;font-family:monospace;min-height:16px;margin-bottom:8px;}.tmit-onboard-validate.ok{color:#50dc82;}.tmit-onboard-validate.err{color:#ff6060;}.tmit-onboard-validate.loading{color:#c9a227;}.tmit-onboard-capacity-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;}.tmit-onboard-cap-val{font-family:'Cinzel',serif;font-size:28px;color:#ffe066;font-weight:700;text-shadow:0 0 16px rgba(255,224,102,0.5);}.tmit-onboard-cap-detail{font-size:10px;color:#5a4a7a;line-height:1.6;}.tmit-onboard-tab-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;}.tmit-onboard-tab-card{background:rgba(0,0,0,0.3);border:1px solid rgba(201,162,39,0.15);border-radius:6px;padding:6px 8px;}.tmit-onboard-tab-card .tab-icon{font-size:16px;}.tmit-onboard-tab-card .tab-name{font-size:11px;font-weight:700;color:#c9a227;margin:3px 0 2px;}.tmit-onboard-tab-card .tab-desc{font-size:10px;color:#5a4a7a;line-height:1.5;}.tmit-onboard-footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px;}.tmit-onboard-dots{display:flex;gap:5px;}.tmit-onboard-dot{width:6px;height:6px;border-radius:50%;background:rgba(201,162,39,0.2);transition:background 0.2s;}.tmit-onboard-dot.active{background:#c9a227;}.tmit-onboard-btn{background:linear-gradient(90deg,#c9a227,#8b6e10);border:none;border-radius:6px;color:#0d0010;font-weight:700;font-size:13px;padding:8px 20px;cursor:pointer;font-family:'Inter',sans-serif;transition:filter 0.15s;}.tmit-onboard-btn:hover{filter:brightness(1.15);}.tmit-onboard-btn:disabled{opacity:0.4;cursor:default;}.tmit-onboard-skip{font-size:11px;color:#3a2a5a;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;}.tmit-onboard-skip:hover{color:#6a5a8a;}.tmit-help{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:rgba(201,162,39,0.12);border:1px solid rgba(201,162,39,0.25);color:#c9a227;font-size:8px;font-weight:700;cursor:help;margin-left:4px;position:relative;vertical-align:middle;flex-shrink:0;}.tmit-help::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);right:0;left:auto;transform:none;background:#1e0f45;border:1px solid rgba(201,162,39,0.3);border-radius:6px;padding:8px 11px;font-size:10px;color:#c8b8e8;white-space:pre-line;width:220px;line-height:1.6;z-index:999999;opacity:0;pointer-events:none;transition:opacity 0.15s;box-shadow:0 6px 24px rgba(0,0,0,0.7);font-family:'Inter',sans-serif;font-weight:400;letter-spacing:0;text-transform:none;}.tmit-help:hover::after{opacity:1;}.tmit-btn-export{background:none;border:1px solid rgba(201,162,39,0.2);color:#6a5a8a;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;transition:all 0.15s;font-family:'Inter',sans-serif;font-weight:600;}.tmit-btn-export:hover{border-color:#c9a227;color:#c9a227;}.tmit-session-bar{padding:4px 12px;background:rgba(0,0,0,0.4);border-bottom:1px solid rgba(201,162,39,0.1);display:flex;gap:12px;align-items:center;font-size:10px;font-family:monospace;flex-shrink:0;}.tmit-session-item{display:flex;align-items:center;gap:4px;color:#4a3a6a;}.tmit-session-val{color:#9080b0;font-weight:600;}.tmit-session-val.positive{color:#50dc82;}.tmit-session-val.hot{color:#e8621a;}.tmit-age-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:3px;}.tmit-age-fresh{background:#50dc82;}.tmit-age-stale{background:#c9a227;}.tmit-age-old{background:#ff6060;}.tmit-btn-retry{display:inline-block;margin-top:8px;background:rgba(201,162,39,0.15);border:1px solid rgba(201,162,39,0.3);border-radius:5px;color:#c9a227;font-size:11px;font-weight:600;padding:5px 14px;cursor:pointer;font-family:'Inter',sans-serif;}.tmit-btn-retry:hover{background:rgba(201,162,39,0.25);}.tmit-skeleton{background:linear-gradient(90deg,rgba(255,255,255,0.03) 0%,rgba(255,255,255,0.07) 50%,rgba(255,255,255,0.03) 100%);background-size:200% 100%;animation:tmit-shimmer 1.4s infinite;border-radius:3px;height:10px;margin:4px 0;}@keyframes tmit-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}.tmit-war-row.orange-item{border-left:2px solid #e8621a;}.tmit-war-row.red-item{border-left:2px solid #ff4040;}.tmit-war-name{color:#d8c8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.tmit-war-price{color:#9080b0;font-family:monospace;font-size:10px;text-align:right;}.tmit-war-bb{color:#ffe066;font-family:monospace;font-size:10px;text-align:right;}.tmit-war-chg{font-family:monospace;font-size:10px;font-weight:700;text-align:right;}
  `);

  // ── API calls ─────────────────────────────────────────────────────────────────

  // apiGet with a custom timeout
  // Core HTTP helper — uses Promise.race to guarantee timeout fires
  // even if GM_xmlhttpRequest ignores the timeout field (some browsers/versions do)
  function _gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:    'GET',
        url,
        timeout:   15000,
        onload:    (r) => {
          try { resolve(JSON.parse(r.responseText)); }
          catch(e) { reject(new Error('JSON parse failed')); }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  function _timeout(ms, label) {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label || 'Request'} timed out after ${ms/1000}s`)), ms)
    );
  }

  // apiGet — 12s hard timeout via Promise.race
  function apiGet(url) {
    return Promise.race([_gmFetch(url), _timeout(12000, 'API call')]);
  }

  // apiGetWithTimeout — custom timeout via Promise.race
  function apiGetWithTimeout(url, timeoutMs) {
    return Promise.race([
      _gmFetch(url).catch(() => ({ _error: 'network' })),
      new Promise(resolve => setTimeout(() => resolve({ _error: 'timeout' }), timeoutMs)),
    ]);
  }

  // ── Price fetching ────────────────────────────────────────────────────────
  //
  // Each poll:
  //   1. Fetch torn/items — metadata (name, type) + market_value for all items
  //   2. Fetch YATA prices in parallel
  //   3. Fetch live market listings for up to MAX_LIVE_ITEMS priority items
  //   4. Record snapshot: live price if available, else YATA, else market_value
  //      BUT only record market_value if it changed — avoids flat history poison
  //
  const MAX_LIVE_ITEMS   = 15;
  const METADATA_TTL_MS  = 6 * 60 * 60 * 1000
  let   lastMetadataFetch = load('lastMetadataFetch', 0);

  // Fetch all items — metadata + market_value fallback prices
  // Cached for 6h in GM storage — most page loads skip this entirely
  async function fetchAllItems(apiKey) {
    const now = Date.now();
    const hasMeta = Object.keys(itemMeta).length > 0;
    const isStale = (now - lastMetadataFetch) > METADATA_TTL_MS;

    // Skip fetch entirely if cached data is still fresh
    if (hasMeta && !isStale) return {};

    // If we have stale cached data, try to refresh but don't block the poll
    // — use a reasonable timeout and fall back gracefully
    try {
      const data = await apiGetWithTimeout(
        `https://api.torn.com/torn/?selections=items&key=${apiKey}&comment=TEEM`,
        20000
      );
      if (data?._error) {
        // Timeout or network error — use cached data if available
        if (hasMeta) return {};
        throw new Error('Torn API unreachable — check your connection');
      }
      if (data?.error) {
        if (hasMeta) return {};
        throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
      }
      const items = data?.items ?? {};
      if (Object.keys(items).length > 0) {
        lastMetadataFetch = now;
        store('lastMetadataFetch', now);
        return items;
      }
      if (hasMeta) return {};
      throw new Error('Torn API returned no items');
    } catch(e) {
      if (hasMeta) return {}
      throw e
    }
  }

  // Fetch live lowest-listing price for a single item (average of lowest 5)
  async function fetchLivePrice(apiKey, itemId) {
    try {
      const data = await apiGetWithTimeout(
        `https://api.torn.com/market/${itemId}?selections=itemmarket&key=${apiKey}&comment=TEEM`,
        5000
      );
      if (data.error) return 0;
      const listings = data?.itemmarket ?? {};
      const prices = Object.values(listings)
        .map(l => l.cost ?? l.price ?? 0)
        .filter(p => p > 0)
        .sort((a, b) => a - b)
        .slice(0, 5);
      if (!prices.length) return 0;
      return prices.length >= 3
        ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)
        : prices[0];
    } catch(e) { return 0; }
  }

  // Build priority list for live fetches
  // High-traffic items always fetched live — these drive most market signals
  // IDs verified from torn/items API (May 2026)
  const ALWAYS_LIVE_IDS = new Set([
    206,  // Xanax
    197,  // LSD
    198,  // Ecstasy
    204,  // Cannabis
    196,  // Vicodin
    367,  // Empty Blood Bag
    366,  // Blood Bag (O-)
    370,  // Blood Bag (AB+)
    618,  // First Aid Kit
    619,  // Small First Aid Kit
    25,   // Beer
    26,   // Bottle of Rum
    259,  // Feathery Hotel Coupon
    260,  // Merits
  ]);

  function buildPriorityList() {
    const ids = new Set();
    // Always fetch live prices for high-traffic items
    for (const id of ALWAYS_LIVE_IDS) ids.add(id);
    // Watchlist
    for (const id of watchlist) ids.add(id);
    for (const country of COUNTRIES) {
      for (const item of country.items) {
        const id = travelItemIdMap[item.itemName];
        if (id) ids.add(id);
      }
    }
    for (const [idStr, m] of Object.entries(itemMeta)) {
      if (ids.size >= MAX_LIVE_ITEMS) break;
      if (isRWItem(m.name, m.type)) ids.add(parseInt(idStr));
    }
    if (ids.size < MAX_LIVE_ITEMS) {
      const volatile = Object.entries(priceHistory)
        .map(([idStr, hist]) => {
          if (hist.length < 2) return null;
          const prices = hist.slice(-20).map(h => h.price || h.yataPrice).filter(Boolean);
          if (prices.length < 2) return null;
          const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
          const variance = prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
          return { id: parseInt(idStr), vol: Math.sqrt(variance) / (mean || 1) };
        })
        .filter(Boolean)
        .sort((a, b) => b.vol - a.vol);
      for (const { id } of volatile) {
        if (ids.size >= MAX_LIVE_ITEMS) break;
        ids.add(id);
      }
    }
    return [...ids].slice(0, MAX_LIVE_ITEMS);
  }

  // Fetch live prices for priority list in batches of 5
  async function fetchLivePrices(apiKey) {
    const ids = buildPriorityList();
    if (!ids.length) return {};
    const live = {};
    const BATCH = 5;
    const deadline = Date.now() + 20000;
    for (let i = 0; i < ids.length; i += BATCH) {
      if (Date.now() > deadline) break;
      const batch = ids.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(id => fetchLivePrice(apiKey, id)));
      batch.forEach((id, j) => { if (results[j] > 0) live[id] = results[j]; });
      if (i + BATCH < ids.length) await new Promise(r => setTimeout(r, 150));
    }
    return live;
  }

  async function fetchYataPrices() {
    try {
      const data = await apiGet('https://yata.life/api/v1/bazaar/abroad/?format=json')
      const result = {};
      for (const [idStr, itemData] of Object.entries(data ?? {})) {
        const price = itemData?.market_value ?? itemData?.price ?? null;
        if (price) result[parseInt(idStr)] = price;
      }
      return result;
    } catch(e) {
      return {};
    }
  }

  function getTimeframeMs(label) {
    return TIMEFRAMES.find(t => t.label === label)?.ms ?? TIMEFRAMES[2].ms;
  }

  function analyzeItem(itemId, currentPrice, yataPrice, timeframeMs) {
    const history = priceHistory[itemId] ?? [];

    // With only 1 snapshot or none, still show the item with no trend data
    if (history.length < 2) {
      const effectivePrice = currentPrice || yataPrice || itemMeta[itemId]?.market_value || 0;
      if (!effectivePrice) return null;
      return {
        itemId: parseInt(itemId),
        name: itemMeta[itemId]?.name ?? `Item #${itemId}`,
        type: itemMeta[itemId]?.type ?? 'Unknown',
        currentPrice: effectivePrice,
        tornPrice: currentPrice,
        yataPrice,
        changePct: 0,
        volatility: 0,
        trendPct: 0,
        signal: 'WATCH',
        confidence: 0,
        isSpike: false,
        isBigSpike: false,
        dataPoints: history.length,
        dataSources: (currentPrice ? 1 : 0) + (yataPrice ? 1 : 0),
        thinData: true,
      };
    }

    const now = Date.now();
    const cutoff = now - timeframeMs;
    const windowData = history.filter(h => h.ts >= cutoff);
    // If not enough window data, use all available history
    const effectiveWindow = windowData.length >= 2 ? windowData : history.slice(-2);
    if (effectiveWindow.length < 2) return null;

    const oldest = effectiveWindow[0];

    // Cross-reference torn vs yata
    const effectivePrice = (currentPrice && yataPrice)
      ? Math.round((currentPrice * 0.6) + (yataPrice * 0.4))
      : (currentPrice || yataPrice || 0);

    const oldestPrice = oldest.price || oldest.yataPrice || 0;
    if (!oldestPrice || !effectivePrice) return null;

    const changePct = ((effectivePrice - oldestPrice) / oldestPrice) * 100;

    // Volatility — std dev of price changes in window
    const prices = effectiveWindow.map(h => h.price || h.yataPrice || 0).filter(Boolean);
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
    const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length;
    const volatility = Math.sqrt(variance) / mean * 100;

    // Trend — simple linear regression slope
    const n = effectiveWindow.length;
    const xs = effectiveWindow.map((_, i) => i);
    const ys = effectiveWindow.map(h => h.price || h.yataPrice || 0);
    const sumX = xs.reduce((a,b) => a+b, 0);
    const sumY = ys.reduce((a,b) => a+b, 0);
    const sumXY = xs.reduce((a,b,i) => a + b*ys[i], 0);
    const sumX2 = xs.reduce((a,b) => a + b*b, 0);
    const slope = n > 1 ? (n*sumXY - sumX*sumY) / (n*sumX2 - sumX*sumX) : 0;
    const trendPct = mean > 0 ? (slope / mean) * 100 : 0;

    // Signal logic
    let signal = 'WATCH';
    let confidence = 1;

    if (changePct > 5 && trendPct > 0) {
      signal = 'BUY'; confidence = Math.min(3, Math.floor(changePct / 5));
    } else if (changePct < -8 && trendPct < 0) {
      signal = 'SELL'; confidence = Math.min(3, Math.floor(Math.abs(changePct) / 8));
    } else if (changePct > 2) {
      signal = 'HOLD'; confidence = 2;
    } else if (Math.abs(changePct) < 1 && volatility > 8) {
      signal = 'WATCH'; confidence = 2;
    }

    // Big spike detection
    const isSpike = Math.abs(changePct) > 15;
    const isBigSpike = Math.abs(changePct) > 30;

    // Data source confidence
    const dataSources = (currentPrice ? 1 : 0) + (yataPrice ? 1 : 0);

    return {
      itemId: parseInt(itemId),
      name: itemMeta[itemId]?.name ?? `Item #${itemId}`,
      type: itemMeta[itemId]?.type ?? 'Unknown',
      currentPrice: effectivePrice,
      tornPrice: currentPrice,
      yataPrice,
      changePct: Math.round(changePct * 10) / 10,
      volatility: Math.round(volatility * 10) / 10,
      trendPct: Math.round(trendPct * 100) / 100,
      signal,
      confidence,
      isSpike,
      isBigSpike,
      dataPoints: effectiveWindow.length,
      dataSources,
    };
  }

  function runAnalysis() {
    const tfMs = getTimeframeMs(settings.selectedTimeframe);
    const results = [];
    const seen = new Set();

    // Items with price history
    for (const [idStr, prices] of Object.entries(priceHistory)) {
      if (!prices.length) continue;
      const latest = prices[prices.length - 1];
      const result = analyzeItem(idStr, latest.price, latest.yataPrice, tfMs);
      if (result) { results.push(result); seen.add(parseInt(idStr)); }
    }

    // Items in itemMeta with no history yet — show with market_value as price
    for (const [idStr, meta] of Object.entries(itemMeta)) {
      const id = parseInt(idStr);
      if (seen.has(id)) continue;
      const mv = meta.market_value ?? 0;
      const yataPrice = lastYataPrices[id] ?? 0;
      if (!mv && !yataPrice) continue;
      const effectivePrice = mv || yataPrice;
      results.push({
        itemId: id,
        name: meta.name ?? `Item #${id}`,
        type: meta.type ?? 'Unknown',
        currentPrice: effectivePrice,
        tornPrice: mv,
        yataPrice,
        changePct: 0,
        volatility: 0,
        trendPct: 0,
        signal: 'WATCH',
        confidence: 0,
        isSpike: false,
        isBigSpike: false,
        dataPoints: 0,
        dataSources: (mv ? 1 : 0) + (yataPrice ? 1 : 0),
        thinData: true,
      });
    }

    // Sort
    results.sort((a, b) => {
      switch (settings.sortBy) {
        case 'profit_pct': return Math.abs(b.changePct) - Math.abs(a.changePct);
        case 'price':      return b.currentPrice - a.currentPrice;
        case 'volatility': return b.volatility - a.volatility;
        case 'signal':     return ['BUY','HOLD','WATCH','SELL'].indexOf(a.signal) - ['BUY','HOLD','WATCH','SELL'].indexOf(b.signal);
        default:           return Math.abs(b.changePct) - Math.abs(a.changePct);
      }
    });

    analysisCache = results;

    // Alert if any big spikes
    const bigSpikes = results.filter(r => r.isBigSpike);
    if (bigSpikes.length > 0 && !alertActive) {
      alertActive = true;
      document.getElementById('tmit-fab')?.classList.add('tmit-alert');
    } else if (bigSpikes.length === 0 && alertActive) {
      alertActive = false;
      document.getElementById('tmit-fab')?.classList.remove('tmit-alert');
    }

    return results;
  }

  async function poll(force = false) {
    if (!settings.apiKey) return;

    try {
      // Only show loading spinner if no cached data is displayed yet
      const hasDisplayedData = Object.keys(priceHistory).length > 0;
      if (!hasDisplayedData) setStatus('loading', 'Fetching…');

      // Step 1: Fetch all items + YATA in parallel
      // fetchAllItems returns {} if itemMeta cache is still fresh
      // Pre-seed itemMeta from hardcoded weapon list on fresh install
      // so the war tab works while the full fetch happens
      const [tornItems, yataPrices] = await Promise.all([
        fetchAllItems(settings.apiKey),
        fetchYataPrices(),
      ]);
      lastYataPrices = yataPrices;

      // Step 2: Update itemMeta only if we got fresh data
      const seenTypes = new Set(['All']);
      const gotFreshItems = Object.keys(tornItems).length > 0;
      if (gotFreshItems) {
        // Remove any temp-seeded entries before writing real data
        for (const k of Object.keys(itemMeta)) { if (String(k).startsWith('rw_')) delete itemMeta[k]; }
        for (const [idStr, item] of Object.entries(tornItems)) {
          const id = parseInt(idStr);
          itemMeta[id] = {
            name:         item.name         ?? `Item #${id}`,
            type:         item.type         ?? 'Unknown',
            market_value: item.market_value ?? 0,
          };
          if (item.type) seenTypes.add(item.type);
        }
        store('itemMeta', itemMeta);
      }
      // Always rebuild seenTypes from current itemMeta
      for (const m of Object.values(itemMeta)) { if (m.type) seenTypes.add(m.type); }

      // Step 3: Resolve travel IDs — skip temp seeded entries (no real numeric ID)
      resolveTravelItemIds(
        Object.fromEntries(
          Object.entries(itemMeta)
            .filter(([id]) => !String(id).startsWith('rw_'))
            .map(([id, m]) => [id, { name: m.name, type: m.type }])
        )
      );

      // Step 4: Fetch live prices for priority items
      const livePrices = await fetchLivePrices(settings.apiKey);

      // Also fetch YATA travel stock for travel tab
      try {
        const travelStock = await apiGet('https://yata.life/api/v1/travel/export/?format=json');
        if (travelStock && !travelStock.error) {
          const result = {};
          for (const [countryKey, countryData] of Object.entries(travelStock?.countries ?? {})) {
            const code = countryKey.toLowerCase().slice(0, 3);
            result[code] = {};
            for (const [itemIdStr, itemData] of Object.entries(countryData?.items ?? {})) {
              const stockPct = itemData?.stock ?? itemData?.quantity ?? 100;
              result[code][parseInt(itemIdStr)] = Math.min(stockPct / 100, 1.0);
            }
          }
          if (Object.keys(result).length > 0) yataStockCache = result;
        }
      } catch(e) { /* silent fail */ }

      // Record price snapshots
      // Priority: live listing > YATA > market_value
      // market_value is recorded only if it changed since last snapshot
      // (avoids flat unchanging history lines for rarely-traded items)
      for (const [idStr, meta] of Object.entries(itemMeta)) {
        const id        = parseInt(idStr);
        const livePrice = livePrices?.[id]   ?? 0;
        const yataPrice = yataPrices[id]      ?? 0;
        const mv        = meta.market_value   ?? 0;

        const tornPrice = livePrice || mv;
        if (tornPrice <= 0 && yataPrice <= 0) continue;

        // For market_value: only record if it changed from last snapshot
        // to avoid flooding history with identical values
        if (!livePrice && mv > 0) {
          const hist = priceHistory[id];
          const lastMv = hist?.length ? hist[hist.length - 1].price : -1;
          if (mv === lastMv) {
            // mv unchanged — still record yata update if we have one
            if (yataPrice > 0) appendHistory(id, 0, yataPrice);
            continue;
          }
        }

        appendHistory(id, tornPrice, yataPrice);
      }

      // Rebuild categories from fresh API types
      CATEGORIES = ['All', ...Array.from(seenTypes).filter(t => t !== 'All').sort()];
      const catSelect = document.getElementById('tmit-cat-select');
      if (catSelect) {
        const currentVal = catSelect.value;
        catSelect.innerHTML = CATEGORIES.map(c =>
          `<option value="${c}"${c === currentVal ? ' selected' : ''}>${c}</option>`
        ).join('');
      }

      saveHistory();

      const liveCount = Object.keys(livePrices).length;
      const srcLabel  = liveCount > 0 ? `⚡ ${liveCount} live` : '~ Avg';
      setStatus('ok', `${srcLabel} · ${new Date().toLocaleTimeString()}`);

      // Fetch inventory for buy/sell features
      try {
        const inv = await apiGet(
          `https://api.torn.com/user/?selections=inventory&key=${settings.apiKey}&comment=TEEM`
        );
        if (inv?.inventory) {
          userInventory = {};
          for (const [, item] of Object.entries(inv.inventory)) {
            const id = item.ID ?? item.id;
            if (id) userInventory[id] = { name: item.name ?? '', quantity: item.quantity ?? 1 };
          }
        }
      } catch(e) { /* optional */ }

      recomputeTravel();
      renderList();
      if (settings.activeTab === 'travel') renderTravelTab();
      populateWarItemDropdown();
    } catch(e) { setStatus('err', e.message.slice(0, 50)); }
  }

  async function pollStats() {
    if (!settings.apiKey) return;
    try {
      await fetchMyBattleStats(settings.apiKey);
      // Re-render stats tab if active
      if (settings.activeTab === 'stats') renderStatsTab();
      // Update session tracker bars
      updateSessionTracker();
    } catch(e) { /* silent */ }
  }

  function startPolling() {
    // Clear any existing timers
    if (pollingTimer) clearInterval(pollingTimer);
    if (statsTimer)   clearInterval(statsTimer);

    const marketMs = Math.max(15, settings.marketPollSec ?? 60) * 1000;
    const statsMs  = Math.max(10, settings.statsPollSec  ?? 30) * 1000;

    // Full market poll (prices, travel, signals)
    poll(true);
    pollingTimer = setInterval(() => poll(), marketMs);

    // Lightweight stats poll (bars, cooldowns, battlestats)
    // Offset by half the interval so it doesn't overlap with market poll
    setTimeout(() => {
      pollStats();
      statsTimer = setInterval(() => pollStats(), statsMs);
    }, Math.min(statsMs / 2, 15000));
  }

  // ── UI ────────────────────────────────────────────────────────────────────────

  function buildUI() {
    if (uiBuilt) return;
    uiBuilt = true;

    // FAB
    const fab = document.createElement('div');
    fab.id = 'tmit-fab';
    fab.innerHTML = `<img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E🐘%3C/text%3E%3C/svg%3E" style="width:34px;height:34px;border-radius:50%;pointer-events:none;" draggable="false"><div class="tmit-alert-dot"></div>`;
    fab.title = "TEEM — Torn's Elephant Economy Manager";
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'tmit-panel';
    panel.classList.add('tmit-hidden');
    panel.innerHTML = `
      <div class="tmit-header" id="tmit-drag-handle">
        <div class="tmit-title">
          <img src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E🐘%3C/text%3E%3C/svg%3E" style="width:22px;height:22px;border-radius:50%;flex-shrink:0;" draggable="false">
          Elephant Economy Manager
        </div>
        <div class="tmit-header-right">
          <span class="tmit-status-pill" id="tmit-status">Loading…</span>
          <button class="tmit-btn-refresh" id="tmit-btn-refresh" title="Refresh now">↻</button>
          <button class="tmit-btn-settings-toggle" id="tmit-btn-settings-toggle" title="Settings">⚙</button>
          <button class="tmit-btn-close" id="tmit-btn-close" title="Close">✕</button>
        </div>
      </div>

      <div class="tmit-session-bar" id="tmit-session-bar">
        <div class="tmit-session-item">📦 Inventory: <span class="tmit-session-val" id="tmit-sess-inv">—</span></div>
        <div class="tmit-session-item">💰 Session: <span class="tmit-session-val positive" id="tmit-sess-profit">$0</span></div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
          <span id="tmit-age-dot" class="tmit-age-dot tmit-age-fresh"></span>
          <span id="tmit-age-text" style="color:#3a2a5a;font-size:9px">—</span>
          <button class="tmit-btn-export" id="tmit-btn-export" title="Export current view to CSV">⬇ CSV</button>
        </div>
      </div>

      <div class="tmit-tab-bar">
        <div class="tmit-tab tmit-tab-active" data-tab="all">Market</div>
        <div class="tmit-tab" data-tab="watchlist">⭐ Watch <span class="tmit-tab-count" id="tmit-watch-count">0</span></div>
        <div class="tmit-tab" data-tab="war">⚔ War Gear</div>
        <div class="tmit-tab" data-tab="travel">✈ Travel</div>
        <div class="tmit-tab" data-tab="stats">⚔ Stats</div>
        <div class="tmit-tab" data-tab="quick">⚡ Quick</div>
      </div>

      <div class="tmit-controls">
        <div class="tmit-timeframe-group" id="tmit-timeframe-group">
          ${TIMEFRAMES.map(t =>
            `<button class="tmit-tf-btn${t.label === settings.selectedTimeframe ? ' tmit-active' : ''}"
              data-tf="${t.label}">${t.label}</button>`
          ).join('')}
        </div>
        <div class="tmit-divider"></div>
        <select class="tmit-select" id="tmit-cat-select">
          ${CATEGORIES.map(c =>
            `<option value="${c}"${c === settings.selectedCategory ? ' selected' : ''}>${c}</option>`
          ).join('')}
        </select>
        <input type="text" class="tmit-search" id="tmit-search" placeholder="Search items…">
      </div>

      <div class="tmit-filter-row">
        <span class="tmit-filter-label">Budget</span>
        <input type="number" class="tmit-input-sm" id="tmit-budget-input"
          placeholder="Max price…" value="${settings.maxBudget || ''}">
        <div class="tmit-divider"></div>
        <span class="tmit-filter-label">Min Δ%</span>
        <input type="number" class="tmit-input-sm" id="tmit-minpct-input"
          placeholder="e.g. 5" value="${settings.minProfit || ''}">
      </div>

      <div class="tmit-col-headers">
        <div class="tmit-col-hdr" data-sort="name">Item</div>
        <div class="tmit-col-hdr${settings.sortBy === 'price' ? ' tmit-sorted' : ''}" data-sort="price">Price</div>
        <div class="tmit-col-hdr${settings.sortBy === 'profit_pct' ? ' tmit-sorted' : ''}" data-sort="profit_pct">Change <span class="tmit-help" data-tip="${TOOLTIPS.change}">?</span></div>
        <div class="tmit-col-hdr${settings.sortBy === 'signal' ? ' tmit-sorted' : ''}" data-sort="signal">Signal <span class="tmit-help" data-tip="${TOOLTIPS.signal}">?</span></div>
      </div>

      <div class="tmit-list" id="tmit-list">
        <div class="tmit-state-msg">
          <div class="tmit-state-icon">💎</div>
          ${settings.apiKey ? 'Fetching market data…' : 'Open ⚙ settings and enter your Torn API key.'}
        </div>
      </div>

      <!-- War Gear Tab -->
      <div id="tmit-war-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">⚔ Ranked War Weapon &amp; Armor Calculator</div>
        <div class="tmit-war-form">

          <!-- Item picker -->
          <div class="tmit-form-row" style="margin-bottom:3px;">
            <label>Search</label>
            <input type="text" id="tmit-war-item-search" placeholder="Type to filter items…"
              class="tmit-input-full" style="flex:1;">
          </div>
          <div class="tmit-form-row" style="margin-bottom:3px;">
            <label>Item</label>
            <select id="tmit-war-item-select" class="tmit-select" style="flex:1;">
              <option value="">— Type above to search —</option>
            </select>
          </div>
          <div style="font-size:9px;color:#3a2a5a;margin-bottom:8px;padding-left:2px;">
            Search by name to find your weapon or armour. Selecting one auto-fills the type field.
          </div>

          <!-- Type + Rarity + Bonuses count — all auto-populated where possible -->
          <div class="tmit-form-row2" style="margin-bottom:6px;">
            <div>
              <label>Type <span style="font-size:8px;color:#3a2a5a;">(auto)</span></label>
              <select id="tmit-war-type" class="tmit-select">
                <option value="">— Select —</option>
                <option value="Pistol/SMG">Pistol / SMG</option>
                <option value="Melee">Melee</option>
                <option value="Shotgun/Rifle">Shotgun / Rifle</option>
                <option value="Heavies">Heavies</option>
                <option value="Armour">Armour</option>
              </select>
            </div>
            <div>
              <label>Rarity</label>
              <select id="tmit-war-rarity" class="tmit-select">
                <option value="">— Select —</option>
                <option value="yellow">🟡 Yellow</option>
                <option value="orange">🟠 Orange</option>
                <option value="red">🔴 Red</option>
              </select>
            </div>
            <div>
              <label># Bonuses</label>
              <select id="tmit-war-bonuses" class="tmit-select">
                <option value="0">0 (Yellow)</option>
                <option value="1">1</option>
                <option value="2">2</option>
              </select>
            </div>
          </div>

          <!-- Bonus dropdowns — populated from type -->
          <div class="tmit-form-row2" style="margin-bottom:8px;">
            <div style="flex:1;">
              <label>Bonus 1 <span style="font-size:8px;color:#3a2a5a;">(from item)</span></label>
              <select id="tmit-war-bonus1-sel" class="tmit-select">
                <option value="">— pick type first —</option>
              </select>
            </div>
            <div style="flex:1;" id="tmit-war-bonus2-wrap" style="display:none;">
              <label>Bonus 2 <span style="font-size:8px;color:#3a2a5a;">(orange/red)</span></label>
              <select id="tmit-war-bonus2-sel" class="tmit-select">
                <option value="">— None —</option>
              </select>
            </div>
          </div>

          <!-- Stats from in-game description -->
          <div style="font-size:9px;font-weight:700;color:#6a5a8a;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px;">
            Stats <span style="font-weight:400;color:#3a2a5a;">— from in-game item description</span>
          </div>
          <div class="tmit-form-row2">
            <div><label>Damage</label><input type="number" id="tmit-war-damage" placeholder="e.g. 52" class="tmit-input-sm"></div>
            <div><label>Accuracy</label><input type="number" id="tmit-war-accuracy" placeholder="e.g. 68" class="tmit-input-sm"></div>
            <div><label>Armor</label><input type="number" id="tmit-war-armor" placeholder="0" class="tmit-input-sm"></div>
          </div>
          <div class="tmit-form-row2" style="margin-top:4px;">
            <div><label>Stealth</label><input type="number" id="tmit-war-stealth" placeholder="0-100" class="tmit-input-sm"></div>
            <div><label>Quality</label><input type="number" id="tmit-war-qual" placeholder="0" class="tmit-input-sm"></div>
          </div>

          <input type="hidden" id="tmit-war-name" value="">
          <input type="hidden" id="tmit-war-bonus1" value="">
          <input type="hidden" id="tmit-war-bonus2" value="">
          <button class="tmit-btn-calc" style="margin-top:10px;width:100%;" id="tmit-war-calc">⚔ Calculate Score &amp; BB Value</button>
        </div>
        <div id="tmit-war-result" class="tmit-calc-result" style="display:none;"></div>

        <div class="tmit-section-title" style="margin-top:14px;">📈 War Gear Price Tracker</div>
        <div style="display:grid;grid-template-columns:1fr 80px 80px 70px 55px;padding:4px 8px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.12);border-radius:4px 4px 0 0;margin-bottom:1px;">
          <div class="tmit-col-hdr">Item Name</div>
          <div class="tmit-col-hdr" style="text-align:right">Price</div>
          <div class="tmit-col-hdr" style="text-align:right">BB Value</div>
          <div class="tmit-col-hdr" style="text-align:right">$ equiv</div>
          <div class="tmit-col-hdr" style="text-align:right">Δ%</div>
        </div>
        <div id="tmit-war-tracker-list" class="tmit-war-tracker">
          <div class="tmit-state-msg" style="padding:16px 0;">
            <div class="tmit-state-icon" style="font-size:20px">⚔</div>
            War gear prices appear here once the market poll detects weapon/armor items.
          </div>
        </div>
      </div>

      <!-- BB Calculator Tab -->
      <div id="tmit-bb-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">🪙 Bunker Bucks Calculator</div>

        <div class="tmit-bb-balance-row">
          <span class="tmit-filter-label">Your BB Balance:</span>
          <span id="tmit-bb-balance-val" class="tmit-bb-bignum">—</span>
          <span class="tmit-filter-label" style="margin-left:12px;">$M per BB:</span>
          <input type="number" id="tmit-bb-rate" class="tmit-input-sm"
            value="${(bbPerDollar/1000000).toFixed(1)}" step="0.5" min="1" max="50"
            title="Current market rate of 1 BB in dollars (millions)">
        </div>

        <div class="tmit-section-title" style="margin-top:10px;">Trade-In Values</div>
        <div id="tmit-bb-tradein" class="tmit-bb-table"></div>

        <div class="tmit-section-title" style="margin-top:12px;">Cache Costs</div>
        <div id="tmit-bb-caches" class="tmit-bb-table"></div>

        <div class="tmit-section-title" style="margin-top:12px;">Grind Estimator</div>
        <div class="tmit-war-form">
          <div class="tmit-form-row2">
            <div>
              <label>Target Item</label>
              <select id="tmit-bb-target" class="tmit-select" style="width:100%">
                ${Object.keys(BB_CACHE_COSTS).map(k => `<option value="${k}">${k}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>Avg BB / War</label>
              <input type="number" id="tmit-bb-per-war" placeholder="e.g. 30" class="tmit-input-sm" value="30">
            </div>
            <div>
              <label>Wars / Week</label>
              <input type="number" id="tmit-bb-wars-week" placeholder="e.g. 3" class="tmit-input-sm" value="3">
            </div>
          </div>
          <button class="tmit-btn-calc" id="tmit-bb-calc">Calculate Grind</button>
        </div>
        <div id="tmit-bb-grind-result" class="tmit-calc-result" style="display:none;"></div>
      </div>

      <!-- Travel Tab -->
      <div id="tmit-travel-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">✈ Travel Profit Rankings</div>

        <!-- Flight type + carry capacity -->
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px;padding:7px 9px;background:rgba(0,0,0,0.25);border-radius:6px;border:1px solid rgba(201,162,39,0.1);">
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="font-size:9px;color:#6a5a8a;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Flight</span>
            <select id="tmit-flight-type" class="tmit-select" style="font-size:10px;">
              <option value="economy"  ${settings.flightType==='economy'  ?'selected':''}>✈ Economy</option>
              <option value="airstrip" ${settings.flightType==='airstrip' ?'selected':''}>🛫 Airstrip (−30%)</option>
              <option value="business" ${settings.flightType==='business' ?'selected':''}>💺 Business (−50%)</option>
              <option value="wlt"      ${settings.flightType==='wlt'      ?'selected':''}>🌟 WLT (−50%)</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="font-size:9px;color:#6a5a8a;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Carry</span>
            <input type="number" id="tmit-travel-capacity" class="tmit-input-sm"
              value="${settings.carryCapacity || 10}" min="1" max="100" style="width:52px;font-size:11px;">
            <span style="font-size:9px;color:#4a3a6a;">items</span>
          </div>
          <button class="tmit-btn-calc" style="margin:0;margin-left:auto;padding:4px 10px;font-size:10px;" id="tmit-travel-refresh">↻</button>
        </div>

        <!-- Alert conditions -->
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px;padding:6px 9px;background:rgba(0,0,0,0.2);border-radius:5px;border:1px solid rgba(201,162,39,0.08);">
          <span style="font-size:9px;color:#6a5a8a;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Alert when:</span>
          <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#8a7aaa;cursor:pointer;">
            <input type="checkbox" id="tmit-alert-drug" ${settings.alertOnDrugClear?'checked':''}
              style="accent-color:#c9a227;cursor:pointer;"> Drug CD clear
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#8a7aaa;cursor:pointer;">
            <input type="checkbox" id="tmit-alert-booster" ${settings.alertOnBoosterClear?'checked':''}
              style="accent-color:#c9a227;cursor:pointer;"> Booster CD clear
          </label>
          <label style="display:flex;align-items:center;gap:4px;font-size:10px;color:#8a7aaa;cursor:pointer;">
            <input type="checkbox" id="tmit-alert-stock" ${settings.alertRequireStock?'checked':''}
              style="accent-color:#c9a227;cursor:pointer;"> Stock confirmed
          </label>
        </div>

        <div class="tmit-col-headers" style="grid-template-columns:24px 1fr 90px 80px 70px;padding:5px 8px;">
          <div class="tmit-col-hdr"></div>
          <div class="tmit-col-hdr">Destination</div>
          <div class="tmit-col-hdr" style="text-align:right">$/hr</div>
          <div class="tmit-col-hdr" style="text-align:right">Trip</div>
          <div class="tmit-col-hdr" style="text-align:right">Stock</div>
        </div>

        <div id="tmit-travel-list">
          <div class="tmit-state-msg">
            <div class="tmit-state-icon">✈</div>
            Travel data loads with the next market poll.
          </div>
        </div>

        <div class="tmit-section-title" style="margin-top:14px;">📋 Trip Details</div>
        <div id="tmit-travel-detail" style="font-size:11px;color:#5a4a7a;padding:6px 0;">
          Click a destination above to see trip details.
        </div>
      </div>

      <!-- Quick Items Tab -->
      <div id="tmit-quick-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">⚡ Quick Use Items</div>
        <div style="font-size:10px;color:#4a3a6a;margin-bottom:10px;line-height:1.6;">
          Save items here for one-click use on the
          <a href="https://www.torn.com/item.php" style="color:#c9a227;text-decoration:none;">Items page</a>.
          TEEM injects a bar at the top of the items page with your saved items.
          Clicking one auto-clicks through Torn's use confirmation for you.
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="tmit-quick-add-name" placeholder="e.g. Xanax"
            class="tmit-input-full" style="flex:1;">
          <button class="tmit-btn-calc" style="margin:0;padding:5px 10px;" id="tmit-quick-add-btn">+ Add</button>
        </div>
        <div id="tmit-quick-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      </div>

      <!-- Stats Tab -->
      <div id="tmit-stats-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">

        <!-- My Stats -->
        <div class="tmit-section-title">⚔ My Battle Stats</div>
        <div style="font-size:10px;color:#4a3a6a;margin-bottom:8px;line-height:1.6;">
          Your current STR/DEF/SPD/DEX, energy bars, and active cooldowns.
          Hit <b style="color:#c9a227;">↻ Update</b> to refresh — also saves a snapshot for gain tracking.
        </div>
        <div id="tmit-bs-bars" style="margin-bottom:10px;"></div>
        <div id="tmit-bs-stats" class="tmit-calc-result" style="margin-bottom:10px;"></div>

        <!-- Stat gain tracking -->
        <div class="tmit-section-title" style="margin-top:12px;">📈 Stat Gain Tracking</div>
        <div style="font-size:10px;color:#4a3a6a;margin-bottom:8px;line-height:1.6;">
          Shows how much your STR/DEF/SPD/DEX have grown between updates.
          Each time you hit <b style="color:#c9a227;">↻ Update</b>, TEEM saves a snapshot.
          Pick a window below to see your gains across those snapshots.
        </div>
        <div class="tmit-filter-row" style="margin-bottom:6px;">
          <span class="tmit-filter-label">Compare over:</span>
          <select id="tmit-sg-window" class="tmit-select">
            <option value="1">Last snapshot</option>
            <option value="7" selected>Last 7 snapshots</option>
            <option value="30">Last 30 snapshots</option>
            <option value="all">All time</option>
          </select>
          <button class="tmit-btn-calc" style="margin:0;margin-left:auto;" id="tmit-bs-refresh">↻ Update</button>
        </div>
        <div id="tmit-sg-result" class="tmit-calc-result" style="margin-bottom:10px;"></div>

        <!-- Spy lookup -->
        <div class="tmit-section-title" style="margin-top:12px;">🔍 Spy Lookup</div>
        <div style="font-size:10px;color:#4a3a6a;margin-bottom:8px;line-height:1.6;">
          Look up another player's battle stats by their Torn ID (the number in their profile URL).
          Uses your TornStats or YATA key to fetch real spy data — or falls back to a rough level-based estimate if no spy exists.
          <br><span style="color:#3a2a5a;">Find someone's ID by visiting their profile: torn.com/profiles.php?<b style="color:#6a5a8a;">XID=1234567</b></span>
        </div>
        <div class="tmit-form-row2" style="margin-bottom:6px;">
          <div>
            <label>Player ID</label>
            <input type="number" id="tmit-spy-id" class="tmit-input-sm" placeholder="e.g. 1234567">
          </div>
          <div style="justify-content:flex-end;">
            <label>&nbsp;</label>
            <button class="tmit-btn-calc" style="margin:0;" id="tmit-spy-lookup">Look Up</button>
          </div>
        </div>
        <div id="tmit-spy-result" class="tmit-calc-result" style="display:none;margin-bottom:10px;"></div>

        <!-- Spy compare -->
        <div class="tmit-section-title" style="margin-top:12px;">⚖ Compare vs Target</div>
        <div style="font-size:10px;color:#4a3a6a;margin-bottom:8px;line-height:1.6;">
          See how you stack up against someone else. Either use the ID lookup above first, or paste a spy report directly.
          Shows the difference per stat — <span style="color:#50dc82;">green = you're stronger</span>, <span style="color:#ff6060;">red = they're stronger</span>.
        </div>
        <textarea id="tmit-spy-paste" placeholder="Paste spy report text here, or enter ID above and click Look Up…"
          style="width:100%;height:70px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.2);border-radius:5px;color:#e8dff5;font-size:11px;padding:7px;outline:none;font-family:monospace;resize:vertical;"></textarea>
        <button class="tmit-btn-calc" style="margin-top:6px;" id="tmit-spy-compare">Compare</button>
        <div id="tmit-compare-result" class="tmit-calc-result" style="display:none;margin-top:8px;"></div>

        <!-- TornStats key setting -->
        <div class="tmit-section-title" style="margin-top:14px;">🔑 TornStats Integration</div>
        <div style="font-size:11px;color:#6a5a8a;padding:8px 10px;background:rgba(201,162,39,0.06);border:1px solid rgba(201,162,39,0.15);border-radius:6px;">
          Add your <b style="color:#c9a227;">TornStats</b> and/or <b style="color:#c9a227;">YATA</b> keys in <b style="color:#ffe066;">⚙ Settings</b> (top right of panel header).<br>
          <span style="font-size:10px;color:#4a3a6a;">These enable exact spy stats next to player names on every Torn page.</span>
        </div>
      </div>

      <div class="tmit-settings-panel" id="tmit-settings-panel">
        <div class="tmit-settings-title">⚙ Settings</div>

        <div style="font-size:10px;color:#4a3a6a;line-height:1.6;margin-bottom:10px;padding:6px 8px;background:rgba(201,162,39,0.05);border:1px solid rgba(201,162,39,0.12);border-radius:5px;">
          All keys are stored locally on your device only — never sent anywhere except directly to that service's own API.
          <b style="color:#c9a227">Create a separate key per service</b> so you can revoke them individually if needed.
        </div>

        <!-- TORN MARKET API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          Torn Market API Key <span style="color:#ff6060;font-weight:400;">★ Required</span>
        </div>
        <div style="font-size:9px;color:#4a3a6a;margin-bottom:5px;line-height:1.5;">
          Used for live item prices, your stats, energy bars &amp; BB balance.
          Get yours at <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">torn.com → Preferences → API ↗</a>
          — a <b style="color:#e8dff5">Limited</b> key is enough.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-apikey-input" placeholder="Paste Torn API key here…"
            value="${settings.apiKey}" autocomplete="off"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-apikey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#6a5a8a;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">👁</button>
        </div>
        <div id="tmit-apikey-status" style="font-size:10px;min-height:14px;margin-bottom:8px;padding-left:2px;"></div>

        <!-- TORNSTATS API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          TornStats API Key <span style="color:#6a5a8a;font-weight:400;">Optional</span>
        </div>
        <div style="font-size:9px;color:#4a3a6a;margin-bottom:5px;line-height:1.5;">
          Enables <b style="color:#e8dff5">exact spy stats</b> shown next to player names on all Torn pages.
          Register free at <a href="https://www.tornstats.com" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">tornstats.com ↗</a>
          using your same Torn API key — then find your TornStats key in your profile there.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-ts-key-input" placeholder="Paste TornStats key here…" autocomplete="off" value="${load('tsKey', '')}"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-tskey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#6a5a8a;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">👁</button>
        </div>
        <div id="tmit-ts-key-status" style="font-size:10px;min-height:14px;margin-bottom:8px;padding-left:2px;"></div>

        <!-- YATA API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          YATA API Key <span style="color:#6a5a8a;font-weight:400;">Optional</span>
        </div>
        <div style="font-size:9px;color:#4a3a6a;margin-bottom:5px;line-height:1.5;">
          Unlocks <b style="color:#e8dff5">YATA spy data</b> for player overlays and more accurate travel stock estimates.
          Log in at <a href="https://yata.life" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">yata.life ↗</a>
          with your Torn account — your YATA key is in your profile settings there.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-yata-key-input" placeholder="Paste YATA key here…" autocomplete="off" value="${load('yataKey', '')}"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-yatakey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#6a5a8a;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">👁</button>
        </div>
        <div id="tmit-yata-key-status" style="font-size:10px;min-height:14px;margin-bottom:10px;padding-left:2px;"></div>

        <button class="tmit-btn-save" id="tmit-btn-save" style="width:100%;">💾 Save All Settings</button>
      </div>

      <div class="tmit-footer">
        <span class="tmit-footer-stat">Items tracked: <span id="tmit-item-count">0</span></span>
        <span class="tmit-footer-stat">Snapshots: <span id="tmit-snapshot-count">0</span></span>
        <span class="tmit-footer-stat">Next poll: <span id="tmit-next-poll">—</span></span>
      </div>
    `;
    document.body.appendChild(panel);

    bindEvents(fab, panel);
    updateFooter();
    setInterval(updateFooter, 30000);

    // Restore FAB position
    if (settings.fabX !== null) {
      fab.style.right  = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left   = settings.fabX + 'px';
      fab.style.top    = settings.fabY + 'px';
    }

    // Panel starts hidden — position is set when it opens (see openPanel())
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  function buildOnboarding(iconDataUrl) {
    const el = document.createElement('div');
    el.id = 'tmit-onboard';
    el.innerHTML = `
      <div class="tmit-onboard-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <img class="tmit-onboard-logo" src="${iconDataUrl}" alt="TEEM" style="width:36px;height:36px;margin:0;flex-shrink:0;">
          <div>
            <div class="tmit-onboard-title" style="font-size:13px;text-align:left;margin:0;">Welcome to TEEM</div>
            <div class="tmit-onboard-subtitle" style="text-align:left;margin:0;font-size:10px;">Let's get you set up — Torn stays usable the whole time</div>
          </div>
          <button id="tmit-ob-close-x" style="margin-left:auto;background:none;border:none;color:#3a2a5a;font-size:16px;cursor:pointer;padding:0;line-height:1;" title="Close (set up later via ⚙ in the panel)">✕</button>
        </div>

        <!-- Step 1: API Key -->
        <div class="tmit-onboard-step active" id="tmit-ob-step-1">
          <div class="tmit-onboard-step-title">Step 1 of 4 — Connect to Torn</div>
          <div class="tmit-onboard-step-body">
            TEEM needs a <b>Torn API key</b> to fetch live market prices, your carry capacity, and BB balance.<br><br>
            A <b>Limited</b> key is enough - just enable <code>Market</code>, <code>User</code>, and <code>Torn</code> access when creating it.
          </div>
          <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener"
            style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;padding:7px 14px;background:rgba(201,162,39,0.12);border:1px solid rgba(201,162,39,0.3);border-radius:6px;color:#ffe066;font-size:11px;font-weight:700;text-decoration:none;transition:background 0.15s;"
            onmouseover="this.style.background='rgba(201,162,39,0.22)'"
            onmouseout="this.style.background='rgba(201,162,39,0.12)'">
            🔑 Open Torn API Settings (new tab) ↗
          </a>
          <div style="font-size:10px;color:#4a3a6a;margin-bottom:8px;">
            Come back here and paste your key below once you've created it — this window stays open.
          </div>
          <input type="password" class="tmit-onboard-input" id="tmit-ob-apikey" placeholder="Paste your API key here…" autocomplete="off">
          <div class="tmit-onboard-validate" id="tmit-ob-validate"></div>
        </div>

        <!-- Step 2: Carry capacity -->
        <div class="tmit-onboard-step" id="tmit-ob-step-2">
          <div class="tmit-onboard-step-title">Step 2 of 4 — Your Carry Capacity</div>
          <div class="tmit-onboard-step-body">
            How many items can you carry per trip? Check your <b>Travel page in-game</b> for the exact number.<br><br>
            Common sources of capacity: base (5) + suitcase (+2/+4) + faction Excursion (+1–10) + property airstrip (+10) + job specials (+2–5).
          </div>
          <div class="tmit-onboard-capacity-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="tmit-onboard-cap-val" id="tmit-ob-cap-val">—</div>
              <div class="tmit-onboard-cap-detail" id="tmit-ob-cap-detail">Detecting from API…</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;width:100%;">
              <label style="font-size:11px;color:#6a5a8a;white-space:nowrap;">Adjust if wrong:</label>
              <input type="number" id="tmit-ob-cap-input" min="1" max="100"
                style="width:70px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.3);border-radius:5px;color:#ffe066;font-family:monospace;font-size:16px;font-weight:700;padding:4px 8px;outline:none;text-align:center;"
                placeholder="29">
              <span style="font-size:10px;color:#4a3a6a;">items per trip</span>
            </div>
            <div style="font-size:10px;color:#4a3a6a;">You can always change this in the ✈ Travel tab.</div>
          </div>
        </div>

        <!-- Step 3: Tab tour -->
        <div class="tmit-onboard-step" id="tmit-ob-step-3">
          <div class="tmit-onboard-step-title">Step 3 of 4 — What's Inside</div>
          <div class="tmit-onboard-tab-grid">
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">📈</div>
              <div class="tab-name">Market</div>
              <div class="tab-desc">Tracks all item prices. Hot/cold signals show what's rising or falling.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">⭐</div>
              <div class="tab-name">Watchlist</div>
              <div class="tab-desc">Pin items to watch. Click any WATCH badge to add it here.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">✈</div>
              <div class="tab-name">Travel</div>
              <div class="tab-desc">Ranks all 11 destinations by profit/hr. Click any for full trip details.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">⚔</div>
              <div class="tab-name">War Gear</div>
              <div class="tab-desc">Calculator for ranked war weapons and armor. Score + BB value.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">🪙</div>
              <div class="tab-name">BB Calc</div>
              <div class="tab-desc">Full Bunker Bucks calculator. Grind estimator, trade-in table, cache costs.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">💰</div>
              <div class="tab-name">Session Bar</div>
              <div class="tab-desc">Live inventory estimate and session profit tracked at the top.</div>
            </div>
          </div>
        </div>

        <!-- Step 4: You're ready -->
        <div class="tmit-onboard-step" id="tmit-ob-step-4">
          <div class="tmit-onboard-step-title">Step 4 of 4 — You're Ready 🐘</div>
          <div class="tmit-onboard-step-body">
            TEEM is now running. A few tips:<br><br>
            • <b>Drag</b> the 🐘 TEEM button anywhere on screen<br>
            • <b>Alt+T</b> toggles the panel from anywhere in Torn<br>
            • Data builds over time — signals get smarter the longer it runs<br>
            • <b>Prices update every minute</b> using live Torn API data<br><br>
            Good luck out there. May the market be ever in your favour.
          </div>
        </div>

        <div class="tmit-onboard-footer">
          <div class="tmit-onboard-dots">
            <div class="tmit-onboard-dot active" id="tmit-ob-dot-1"></div>
            <div class="tmit-onboard-dot" id="tmit-ob-dot-2"></div>
            <div class="tmit-onboard-dot" id="tmit-ob-dot-3"></div>
            <div class="tmit-onboard-dot" id="tmit-ob-dot-4"></div>
          </div>
          <div style="display:flex;gap:10px;align-items:center;">
            <button class="tmit-onboard-skip" id="tmit-ob-skip">Skip setup</button>
            <button class="tmit-onboard-btn" id="tmit-ob-next" disabled>Next →</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(el);

    let currentStep = 1;
    const totalSteps = 4;
    let validatedKey = '';
    let detectedCapacity = null;

    const nextBtn   = el.querySelector('#tmit-ob-next');
    const skipBtn   = el.querySelector('#tmit-ob-skip');
    const keyInput  = el.querySelector('#tmit-ob-apikey');
    const validateEl = el.querySelector('#tmit-ob-validate');

    function setStep(n) {
      currentStep = n;
      for (let i = 1; i <= totalSteps; i++) {
        el.querySelector(`#tmit-ob-step-${i}`).classList.toggle('active', i === n);
        el.querySelector(`#tmit-ob-dot-${i}`).classList.toggle('active', i === n);
      }
      nextBtn.textContent = n === totalSteps ? 'Start TEEM →' : 'Next →';
      nextBtn.disabled = (n === 1 && !validatedKey);
    }

    // API key validation
    let validateTimer;
    keyInput.addEventListener('input', () => {
      clearTimeout(validateTimer);
      nextBtn.disabled = true;
      validateEl.className = 'tmit-onboard-validate';
      validateEl.textContent = '';
      const val = keyInput.value.trim();
      if (val.length < 16) return;
      validateTimer = setTimeout(async () => {
        validateEl.className = 'tmit-onboard-validate loading';
        validateEl.textContent = 'Checking key…';
        try {
          const data = await apiGet(
            `https://api.torn.com/user/?selections=basic&key=${val}&comment=TEEM`
          );
          if (data.error) {
            validateEl.className = 'tmit-onboard-validate err';
            validateEl.textContent = `✗ ${data.error.error}`;
          } else {
            validateEl.className = 'tmit-onboard-validate ok';
            validateEl.textContent = `✓ Connected as ${data.name}`;
            validatedKey = val;
            nextBtn.disabled = false;
          }
        } catch(e) {
          validateEl.className = 'tmit-onboard-validate err';
          validateEl.textContent = `✗ ${e.message}`;
        }
      }, 600);
    });

    nextBtn.addEventListener('click', async () => {
      if (currentStep === 1) {
        // Save API key
        settings.apiKey = validatedKey;
        saveSettings();
        // Move to step 2 and detect capacity
        setStep(2);
        const capVal    = el.querySelector('#tmit-ob-cap-val');
        const capDetail  = el.querySelector('#tmit-ob-cap-detail');
        const capInput   = el.querySelector('#tmit-ob-cap-input');
        capVal.textContent = '…';
        capDetail.textContent = 'Checking API…';
        const cap = await detectCarryCapacity(validatedKey);
        detectedCapacity = cap ?? 10;
        capVal.textContent = detectedCapacity;
        capInput.value = detectedCapacity;
        const isGuess = !cap || cap === 10;
        capDetail.textContent = isGuess
          ? '⚠ Could not auto-detect — please enter your actual number above'
          : '✓ Detected from your API data — adjust if needed';
        capDetail.style.color = isGuess ? '#e8621a' : '#50dc82';

        // Keep settings in sync when user edits the input
        capInput.addEventListener('input', () => {
          const v = parseInt(capInput.value) || 10;
          detectedCapacity = v;
          capVal.textContent = v;
        });
      } else if (currentStep === 2) {
        // Commit whatever is in the input field
        const capInput = el.querySelector('#tmit-ob-cap-input');
        const finalCap = parseInt(capInput?.value) || detectedCapacity || 10;
        settings.carryCapacity = finalCap;
        saveSettings();
        setStep(currentStep + 1);
      } else if (currentStep < totalSteps) { setStep(currentStep + 1); } else { finishOnboarding(); }
    });

    skipBtn.addEventListener('click', finishOnboarding);

    // X button in top-right — same as skip
    el.querySelector('#tmit-ob-close-x')?.addEventListener('click', finishOnboarding);

    function finishOnboarding() {
      el.remove();
      onboardingDone = true;
      store('onboardingDone', true);
      saveSettings()
      if (settings.apiKey) startPolling();
    }

    // Auto-open Torn API settings page so user can get their key immediately
    // Small delay so user can see what's happening first
    setTimeout(() => {
      window.open('https://www.torn.com/preferences.php#tab=api', '_blank', 'noopener');
    }, 800);

    // Start with next disabled until key validated
    nextBtn.disabled = true;
  }

  function openPanel(fab, panel) {
    panel.classList.remove('tmit-hidden');

    // If user has previously moved the panel, restore that position
    if (settings.posX !== null) {
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left   = settings.posX + 'px';
      panel.style.top    = settings.posY + 'px';
    } else {
      // First open — position relative to FAB
      const fabRect    = fab.getBoundingClientRect();
      const panelW     = 480;
      const panelH     = 600;
      const margin     = 10;
      // Try to open above-left of FAB; clamp to viewport
      let left = fabRect.left - panelW + fabRect.width;
      let top  = fabRect.top  - panelH - margin;
      left = Math.max(margin, Math.min(window.innerWidth  - panelW - margin, left));
      top  = Math.max(margin, Math.min(window.innerHeight - panelH - margin, top));
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left   = left + 'px';
      panel.style.top    = top  + 'px';
    }

    switchTab(settings.activeTab || 'all');
  }

  function bindEvents(fab, panel) {
    // FAB — simple click to open/close, drag to reposition
    let fabDragging = false;
    let fabStartX = 0, fabStartY = 0, fabOx = 0, fabOy = 0;

    fab.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      fabDragging = false;
      fabStartX = e.clientX;
      fabStartY = e.clientY;
      const rect = fab.getBoundingClientRect();
      fabOx = rect.left;
      fabOy = rect.top;

      const onMove = (e) => {
        const dx = e.clientX - fabStartX;
        const dy = e.clientY - fabStartY;
        if (Math.sqrt(dx*dx + dy*dy) > 5) {
          fabDragging = true;
          fab.style.right  = 'auto';
          fab.style.bottom = 'auto';
          fab.style.left   = Math.max(0, Math.min(window.innerWidth  - 56, fabOx + dx)) + 'px';
          fab.style.top    = Math.max(0, Math.min(window.innerHeight - 56, fabOy + dy)) + 'px';
        }
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup',   onUp);
        if (fabDragging) {
          settings.fabX = parseInt(fab.style.left);
          settings.fabY = parseInt(fab.style.top);
          settings.posX = null; settings.posY = null;
          saveSettings();
        } else {
          // Simple click — toggle panel
          if (panel.classList.contains('tmit-hidden')) openPanel(fab, panel);
          else panel.classList.add('tmit-hidden');
        }
        fabDragging = false;
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    panel.querySelector('#tmit-btn-close').addEventListener('click', () => { panel.classList.add('tmit-hidden'); });

    // Refresh
    panel.querySelector('#tmit-btn-refresh').addEventListener('click', () => poll(true));

    // Eye toggle buttons — show/hide API key fields
    panel.addEventListener('click', (e) => {
      const toggleMap = {
        'tmit-apikey-toggle':  '#tmit-apikey-input',
        'tmit-tskey-toggle':   '#tmit-ts-key-input',
        'tmit-yatakey-toggle': '#tmit-yata-key-input',
      };
      const selector = toggleMap[e.target.id];
      if (!selector) return;
      const inp = panel.querySelector(selector);
      if (!inp) return;
      inp.type = inp.type === 'password' ? 'text' : 'password';
      e.target.textContent = inp.type === 'password' ? '👁' : '🙈';
    });

    // Settings toggle
    panel.querySelector('#tmit-btn-settings-toggle').addEventListener('click', () => {
      panel.querySelector('#tmit-settings-panel').classList.toggle('tmit-open');
      // Ensure key fields are populated (safety net — should already be set from build)
      const tsInput   = panel.querySelector('#tmit-ts-key-input');
      const yataInput = panel.querySelector('#tmit-yata-key-input');
      if (tsInput   && !tsInput.value)   tsInput.value   = load('tsKey',   '');
      if (yataInput && !yataInput.value) yataInput.value = load('yataKey', '');
    });

    // Save settings
    panel.querySelector('#tmit-btn-save').addEventListener('click', () => {
      const key        = panel.querySelector('#tmit-apikey-input')?.value.trim()    || '';
      const tsKey      = panel.querySelector('#tmit-ts-key-input')?.value.trim()   || '';
      const yataKey    = panel.querySelector('#tmit-yata-key-input')?.value.trim() || '';
      const marketPoll = parseInt(panel.querySelector('#tmit-market-poll')?.value) || 60;
      const statsPoll  = parseInt(panel.querySelector('#tmit-stats-poll')?.value)  || 30;

      // Only save non-empty values — never overwrite a saved key with blank
      if (key)     { settings.apiKey = key; }
      if (tsKey)   store('tsKey',   tsKey);
      if (yataKey) store('yataKey', yataKey);

      // Always save poll intervals and restart timers if changed
      const intervalsChanged = settings.marketPollSec !== marketPoll || settings.statsPollSec !== statsPoll;
      settings.marketPollSec = Math.max(15, marketPoll);
      settings.statsPollSec  = Math.max(10, statsPoll);
      saveSettings();

      if (intervalsChanged && settings.apiKey) startPolling();

      // Feedback
      const saved = [key && 'Torn', tsKey && 'TornStats', yataKey && 'YATA'].filter(Boolean);
      if (saved.length) {
        const statusEl = document.getElementById('tmit-ts-key-status');
        if (statusEl) {
          statusEl.textContent = '✓ ' + saved.join(', ') + ' key' + (saved.length > 1 ? 's' : '') + ' saved';
          statusEl.style.color = '#50dc82';
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
      }

      panel.querySelector('#tmit-settings-panel').classList.remove('tmit-open');
      if (key) startPolling();
    });

    // Tab switching
    panel.querySelector('.tmit-tab-bar').addEventListener('click', (e) => {
      const tab = e.target.closest('.tmit-tab');
      if (!tab) return;
      panel.querySelectorAll('.tmit-tab').forEach(t => t.classList.remove('tmit-tab-active'));
      tab.classList.add('tmit-tab-active');
      switchTab(tab.dataset.tab);
    });

    // Timeframe buttons
    panel.querySelector('#tmit-timeframe-group').addEventListener('click', (e) => {
      const btn = e.target.closest('.tmit-tf-btn');
      if (!btn) return;
      panel.querySelectorAll('.tmit-tf-btn').forEach(b => b.classList.remove('tmit-active'));
      btn.classList.add('tmit-active');
      settings.selectedTimeframe = btn.dataset.tf;
      saveSettings();
      renderList();
    });

    // Category select
    panel.querySelector('#tmit-cat-select').addEventListener('change', (e) => {
      settings.selectedCategory = e.target.value;
      saveSettings();
      renderList();
    });

    // Search
    panel.querySelector('#tmit-search').addEventListener('input', () => renderList());

    // Budget / min pct filters
    panel.querySelector('#tmit-budget-input').addEventListener('change', (e) => {
      settings.maxBudget = parseInt(e.target.value) || 0;
      saveSettings();
      renderList();
    });

    panel.querySelector('#tmit-minpct-input').addEventListener('change', (e) => {
      settings.minProfit = parseFloat(e.target.value) || 0;
      saveSettings();
      renderList();
    });

    // Market row pin + buy buttons
    panel.addEventListener('click', (e) => {
      const pinBtn = e.target.closest('.tmit-pin-row');
      if (pinBtn) {
        const id = parseInt(pinBtn.dataset.id);
        if (watchlist.has(id)) { watchlist.delete(id); } else { watchlist.add(id); }
        saveWatchlist();
        renderList();
        return;
      }
    });

    // Market buy/sell buttons
    panel.addEventListener('click', (e) => {
      const buyBtn  = e.target.closest('.tmit-buy-btn');
      const sellBtn = e.target.closest('.tmit-sell-btn');
      if (buyBtn) {
        injectBuyFlow(parseInt(buyBtn.dataset.id), buyBtn.dataset.name, buyBtn.dataset.cat);
      }
      if (sellBtn) {
        injectSellFlow(
          parseInt(sellBtn.dataset.id),
          sellBtn.dataset.name,
          parseInt(sellBtn.dataset.qty),
          parseInt(sellBtn.dataset.price)
        );
      }
    });

    // War item search — filter dropdown as user types
    panel.addEventListener('input', (e) => {
      if (e.target.id === 'tmit-war-item-search') { populateWarItemDropdown(e.target.value); }
    });

    // War calculator — item select, type, rarity, bonus dropdowns
    function updateWarBonusDropdowns() {
      const typeVal   = (document.getElementById('tmit-war-type')?.value    || '').toLowerCase();
      const rarityVal =  document.getElementById('tmit-war-rarity')?.value  || '';
      const countVal  = parseInt(document.getElementById('tmit-war-bonuses')?.value ?? 0);
      const b1sel     = document.getElementById('tmit-war-bonus1-sel');
      const b2sel     = document.getElementById('tmit-war-bonus2-sel');
      const b2wrap    = document.getElementById('tmit-war-bonus2-wrap');
      const b1hidden  = document.getElementById('tmit-war-bonus1');
      const b2hidden  = document.getElementById('tmit-war-bonus2');
      if (!b1sel) return;

      const bonuses = getBonusesForType(typeVal);

      // Populate bonus 1
      const prev1 = b1sel.value;
      b1sel.innerHTML = '<option value="">— None —</option>'
        + bonuses.map(b => `<option value="${b}"${b === prev1 ? ' selected' : ''}>${b}</option>`).join('');
      if (b1hidden) b1hidden.value = b1sel.value;

      // Show bonus 2 when rarity is orange/red or count >= 2
      const show2 = rarityVal === 'orange' || rarityVal === 'red' || countVal >= 2;
      if (b2wrap) b2wrap.style.display = show2 ? '' : 'none';

      // Populate bonus 2, excluding whatever is in bonus 1
      if (b2sel) {
        const prev2 = b2sel.value;
        b2sel.innerHTML = '<option value="">— None —</option>'
          + bonuses.filter(b => b !== b1sel.value)
              .map(b => `<option value="${b}"${b === prev2 ? ' selected' : ''}>${b}</option>`).join('');
        if (b2hidden) b2hidden.value = b2sel.value;
      }
    }

    panel.addEventListener('change', (e) => {
      const id = e.target.id;

      // Item picked — auto-fill type field, saved stats, and update bonuses
      if (id === 'tmit-war-item-select') {
        const opt = e.target.selectedOptions[0];
        if (!opt?.value) return;
        const typeSelect = document.getElementById('tmit-war-type');
        if (typeSelect && opt.dataset.type) typeSelect.value = opt.dataset.type;
        const nameHidden = document.getElementById('tmit-war-name');
        if (nameHidden) nameHidden.value = opt.value;

        // Pre-fill saved stats if we have them
        const saved = warItemStats[opt.value];
        if (saved) {
          const fields = ['damage','accuracy','armor','stealth','exp'];
          fields.forEach(f => {
            const el = document.getElementById('tmit-war-' + f);
            if (el && saved[f] !== undefined) el.value = saved[f];
          });
        } else {
          // Clear stat fields so user doesn't see stale values from last item
          ['damage','accuracy','armor','stealth','exp'].forEach(f => {
            const el = document.getElementById('tmit-war-' + f);
            if (el) el.value = '';
          });
        }
        updateWarBonusDropdowns();
      }

      // Type changed — repopulate bonuses for new type
      if (id === 'tmit-war-type') updateWarBonusDropdowns();

      // Rarity changed — show/hide bonus 2
      if (id === 'tmit-war-rarity') updateWarBonusDropdowns();

      // Bonus count changed
      if (id === 'tmit-war-bonuses') updateWarBonusDropdowns();

      // Bonus 1 selected — sync hidden input, refresh bonus 2 to exclude it
      if (id === 'tmit-war-bonus1-sel') {
        const h = document.getElementById('tmit-war-bonus1');
        if (h) h.value = e.target.value;
        updateWarBonusDropdowns();
      }

      // Bonus 2 selected — sync hidden input
      if (id === 'tmit-war-bonus2-sel') {
        const h = document.getElementById('tmit-war-bonus2');
        if (h) h.value = e.target.value;
      }
    });

    // War gear calculator
    panel.addEventListener('click', (e) => {
      if (e.target.id === 'tmit-war-calc') {
        const name     = document.getElementById('tmit-war-name').value.trim();
        const damage   = parseFloat(document.getElementById('tmit-war-damage').value) || 0;
        const accuracy = parseFloat(document.getElementById('tmit-war-accuracy').value) || 0;
        const armor    = parseFloat(document.getElementById('tmit-war-armor').value) || 0;
        const stealth  = parseFloat(document.getElementById('tmit-war-stealth').value) || 0;
        const exp      = parseFloat(document.getElementById('tmit-war-qual').value) || 0;
        const rarity   = document.getElementById('tmit-war-rarity').value;
        const bonuses  = document.getElementById('tmit-war-bonuses').value;
        const wtype    = document.getElementById('tmit-war-type').value;
        const bonus1   = document.getElementById('tmit-war-bonus1').value.trim();
        const bonus2   = document.getElementById('tmit-war-bonus2').value.trim();

        const bbVal    = getBBValue(rarity, bonuses, wtype);
        const bbDollar = bbVal > 0 ? Math.round(bbVal * bbPerDollar) : 0;

        // Score: weighted combo of damage*accuracy (DPS proxy) + armor
        const dpsScore    = damage && accuracy ? Math.round(damage * accuracy / 100) : 0;
        const overallScore = Math.min(100, Math.round(
          (damage / 100 * 35) + (accuracy / 100 * 35) + (armor / 100 * 20) + (stealth / 100 * 10)
        ));

        // Score bar color based on overall
        const barColor = overallScore >= 70 ? 'hot' : overallScore >= 40 ? 'gold' : 'icy';
        const bars = Array.from({length:10}, (_,i) =>
          `<div class="tmit-score-segment ${i < Math.round(overallScore/10) ? 'filled-'+barColor : ''}"></div>`
        ).join('');

        const resultEl = document.getElementById('tmit-war-result');
        resultEl.style.display = 'block';
        resultEl.innerHTML = `
          <div class="tmit-result-row"><span class="tmit-result-label">Item</span><span class="tmit-result-val gold">${name || '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Damage</span><span class="tmit-result-val hot">${damage || '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Accuracy</span><span class="tmit-result-val hot">${accuracy || '—'}%</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Armor Rating</span><span class="tmit-result-val icy">${armor || '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Stealth</span><span class="tmit-result-val">${stealth || '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Quality</span><span class="tmit-result-val">${exp || '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">DPS Score</span><span class="tmit-result-val ${dpsScore>50?'hot':'icy'}">${dpsScore || '—'}</span></div>
          ${bonus1 ? `<div class="tmit-result-row"><span class="tmit-result-label">Bonus 1</span><span class="tmit-result-val gold">${bonus1}</span></div>` : ''}
          ${bonus2 ? `<div class="tmit-result-row"><span class="tmit-result-label">Bonus 2</span><span class="tmit-result-val gold">${bonus2}</span></div>` : ''}
          <div class="tmit-result-row"><span class="tmit-result-label">BB Value</span><span class="tmit-result-val gold">${bbVal ? bbVal+' BB' : '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">BB in $</span><span class="tmit-result-val green">${bbDollar ? '$'+bbDollar.toLocaleString() : '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Overall Score</span><span class="tmit-result-val ${barColor==='hot'?'hot':barColor==='gold'?'gold':'icy'}">${overallScore}/100</span></div>
          <div class="tmit-score-bar">${bars}</div>
          ${name ? `
          <button id="tmit-war-save-stats" data-name="${name}"
            style="margin-top:8px;width:100%;background:rgba(80,180,100,0.15);border:1px solid rgba(80,180,100,0.3);
                   border-radius:5px;color:#50dc82;font-size:10px;padding:5px 0;cursor:pointer;font-family:monospace;">
            💾 Save stats for "${name}"
          </button>` : ''}
        `;
      }

      // Save war item stats
      if (e.target.id === 'tmit-war-save-stats') {
        const name = e.target.dataset.name;
        if (!name) return;
        warItemStats[name] = {
          damage:   parseFloat(document.getElementById('tmit-war-damage')?.value)   || 0,
          accuracy: parseFloat(document.getElementById('tmit-war-accuracy')?.value) || 0,
          armor:    parseFloat(document.getElementById('tmit-war-armor')?.value)    || 0,
          stealth:  parseFloat(document.getElementById('tmit-war-stealth')?.value)  || 0,
          exp:      parseFloat(document.getElementById('tmit-war-qual')?.value)      || 0,
        };
        store('warItemStats', warItemStats);
        e.target.textContent = '✓ Saved — will auto-fill next time';
        e.target.style.color = '#c9a227';
        e.target.disabled = true;
      }
      });

    // Quick items tab — add/remove
    panel.addEventListener('click', (e) => {
      if (e.target.id === 'tmit-quick-add-btn') {
        const input = document.getElementById('tmit-quick-add-name');
        const name  = (input?.value || '').trim();
        if (!name) return;
        if (!quickItems.some(i => i.name.toLowerCase() === name.toLowerCase())) {
          quickItems.push({ name });
          store('quickItems', quickItems);
        }
        input.value = '';
        renderQuickTab();
      }
      const removeIdx = e.target.dataset.quickRemove;
      if (removeIdx !== undefined) {
        quickItems.splice(parseInt(removeIdx), 1);
        store('quickItems', quickItems);
        renderQuickTab();
      }
    });

    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'tmit-quick-add-name') { document.getElementById('tmit-quick-add-btn')?.click(); }
    });

    // Stats tab events
    panel.addEventListener('click', async (e) => {
      if (e.target.id === 'tmit-bs-refresh') {
        e.target.textContent = '…';
        await fetchMyBattleStats(settings.apiKey);
        renderStatsTab();
        e.target.textContent = '↻ Update';
      }
      if (e.target.id === 'tmit-spy-lookup') {
        const id = document.getElementById('tmit-spy-id')?.value.trim();
        if (id) await doSpyLookup(id);
      }
      if (e.target.id === 'tmit-spy-compare') {
        const pasteText = document.getElementById('tmit-spy-paste')?.value.trim();
        const idInput   = document.getElementById('tmit-spy-id')?.value.trim();
        let   spy       = null;
        if (idInput && playerCache[idInput]?.spy) { spy = playerCache[idInput].spy; } else if (pasteText) {
          spy = parseSpyText(pasteText);
          if (!spy.str && !spy.def && !spy.spd && !spy.dex) {
            const r = document.getElementById('tmit-compare-result');
            if (r) { r.style.display = 'block'; r.innerHTML = '<div style="color:#ff6060;font-size:11px;">Could not parse spy report. Try a different format or use ID lookup above.</div>'; }
            return;
          }
        }
        if (spy && myBattleStats) doSpyCompare(spy);
        else if (!myBattleStats) {
          const r = document.getElementById('tmit-compare-result');
          if (r) { r.style.display = 'block'; r.innerHTML = '<div style="color:#ff6060;font-size:11px;">Fetch your own stats first (↻ Update).</div>'; }
        }
      }
      // TornStats key is now saved via main settings panel
    });

    panel.addEventListener('change', (e) => {
      if (e.target.id === 'tmit-sg-window') { renderStatGains(e.target.value); }
    });

    // Export button
    panel.querySelector('#tmit-btn-export')?.addEventListener('click', exportCurrentView);

    // Travel refresh button
    panel.addEventListener('click', (e) => { if (e.target.id === 'tmit-travel-refresh') poll(true); });

    // Flight type selector
    panel.addEventListener('change', (e) => {
      if (e.target.id === 'tmit-flight-type') {
        settings.flightType = e.target.value;
        saveSettings();
        recomputeTravel();
        renderTravelTab();
      }
      if (e.target.id === 'tmit-alert-drug') {
        settings.alertOnDrugClear = e.target.checked;
        saveSettings();
      }
      if (e.target.id === 'tmit-alert-booster') {
        settings.alertOnBoosterClear = e.target.checked;
        saveSettings();
      }
      if (e.target.id === 'tmit-alert-stock') {
        settings.alertRequireStock = e.target.checked;
        saveSettings();
      }
    });

    // Travel capacity change
    panel.addEventListener('change', (e) => {
      if (e.target.id === 'tmit-travel-capacity') {
        settings.carryCapacity = parseInt(e.target.value) || 10;
        saveSettings();
        recomputeTravel();
        renderTravelTab();
      }
    });

    // Watch badge click delegation
    panel.querySelector('#tmit-list').addEventListener('click', (e) => {
      const badge = e.target.closest('.tmit-signal-badge.WATCH');
      if (!badge) return;
      const row = badge.closest('[data-item-id]');
      if (!row) return;
      const id = parseInt(row.dataset.itemId);
      if (watchlist.has(id)) {
        watchlist.delete(id);
        badge.classList.remove('tmit-watched');
      } else {
        watchlist.add(id);
        badge.classList.add('tmit-watched');
      }
      saveWatchlist();
      updateWatchCount();
      // If on watchlist tab, re-render to reflect removal
      if (settings.activeTab === 'watchlist') renderList();
    });

    // Column sort headers
    panel.querySelector('.tmit-col-headers').addEventListener('click', (e) => {
      const hdr = e.target.closest('.tmit-col-hdr');
      if (!hdr || !hdr.dataset.sort || hdr.dataset.sort === 'name') return;
      settings.sortBy = hdr.dataset.sort;
      saveSettings();
      panel.querySelectorAll('.tmit-col-hdr').forEach(h => h.classList.remove('tmit-sorted'));
      hdr.classList.add('tmit-sorted');
      renderList();
    });

    // Drag to reposition
    makeDraggable(panel, panel.querySelector('#tmit-drag-handle'));
  }

  // ── Stats Tab ─────────────────────────────────────────────────────────────

  function switchTab(tab) {
    settings.activeTab = tab;
    saveSettings();

    const controls   = document.querySelector('.tmit-controls');
    const filterRow  = document.querySelector('.tmit-filter-row');
    const colHeaders = document.querySelector('.tmit-col-headers');
    const listEl     = document.getElementById('tmit-list');
    const warPanel   = document.getElementById('tmit-war-panel');
    const bbPanel    = document.getElementById('tmit-bb-panel');
    const travelPanel = document.getElementById('tmit-travel-panel');
    const statsPanel  = document.getElementById('tmit-stats-panel');
    const quickPanel  = document.getElementById('tmit-quick-panel');

    const isMarket = tab === 'all' || tab === 'watchlist';
    if (controls)     controls.style.display    = isMarket ? '' : 'none';
    if (filterRow)    filterRow.style.display   = isMarket ? '' : 'none';
    if (colHeaders)   colHeaders.style.display  = isMarket ? '' : 'none';
    if (listEl)       listEl.style.display      = isMarket ? '' : 'none';
    if (warPanel)     warPanel.style.display    = tab === 'war'    ? 'flex' : 'none';
    if (bbPanel)      bbPanel.style.display     = tab === 'bb'     ? 'flex' : 'none';
    if (travelPanel)  travelPanel.style.display = tab === 'travel' ? 'flex' : 'none';
    if (statsPanel)   statsPanel.style.display  = tab === 'stats'  ? 'flex' : 'none';
    if (quickPanel)   quickPanel.style.display  = tab === 'quick'  ? 'flex' : 'none';

    // Update active tab highlight
    document.querySelectorAll('.tmit-tab').forEach(t =>
      t.classList.toggle('tmit-tab-active', t.dataset.tab === tab)
    );

    if (isMarket)           renderList();
    else if (tab === 'war')    { renderWarTab(); populateWarItemDropdown(); }
    else if (tab === 'quick')  renderQuickTab();
    else if (tab === 'travel') renderTravelTab();
    else if (tab === 'stats')  renderStatsTab();
  }

  function renderStatsTab() {
    renderMyBattleStats();
    renderStatGains('7');
    // Load TornStats key if saved
    const tsKey = load('tsKey', '');
    const tsInput = document.getElementById('tmit-ts-key-input');
    if (tsInput && tsKey) tsInput.value = tsKey;
  }

  function renderMyBattleStats() {
    const barsEl  = document.getElementById('tmit-bs-bars');
    const statsEl = document.getElementById('tmit-bs-stats');
    if (!barsEl || !statsEl) return;

    if (!myBattleStats) {
      barsEl.innerHTML  = '';
      statsEl.innerHTML = '<div style="color:#4a3a6a;font-size:11px;">No data yet — click ↻ Update to fetch your stats.</div>';
      statsEl.style.display = 'block';
      return;
    }

    const bs = myBattleStats;

    // Energy / nerve / happy / life bars
    const bars = [
      { label: 'Energy', cur: bs.energy,  max: bs.energyMax,  color: '#e8621a' },
      { label: 'Nerve',  cur: bs.nerve,   max: bs.nerveMax,   color: '#c9a227' },
      { label: 'Happy',  cur: bs.happy,   max: bs.happyMax,   color: '#50dc82' },
      { label: 'Life',   cur: bs.life,    max: bs.lifeMax,    color: '#3dd6c8' },
    ];

    barsEl.innerHTML = bars.map(b => {
      const pct = b.max > 0 ? Math.round((b.cur / b.max) * 100) : 0;
      return `<div class="tmit-bar-row">
        <span class="tmit-bar-label">${b.label}</span>
        <div class="tmit-bar-track">
          <div class="tmit-bar-fill" style="width:${pct}%;background:${b.color};"></div>
        </div>
        <span class="tmit-bar-val">${b.cur}/${b.max}</span>
      </div>`;
    }).join('');

    // Battle stats
    const maxStat = Math.max(bs.str, bs.def, bs.spd, bs.dex, 1);
    const statColors = { STR:'#e8621a', DEF:'#3dd6c8', SPD:'#c9a227', DEX:'#b080ff' };
    const stats = [
      { key:'STR', val: bs.str, mod: bs.strMod },
      { key:'DEF', val: bs.def, mod: bs.defMod },
      { key:'SPD', val: bs.spd, mod: bs.spdMod },
      { key:'DEX', val: bs.dex, mod: bs.dexMod },
    ];

    const statRows = stats.map(s => {
      const pct = Math.round((s.val / maxStat) * 100);
      const modColor = s.mod > 100 ? '#50dc82' : s.mod < 100 ? '#ff6060' : '#5a4a7a';
      const modStr = s.mod !== 100 ? `<span class="tmit-bar-mod" style="color:${modColor}">${s.mod}%</span>` : '<span class="tmit-bar-mod"></span>';
      return `<div class="tmit-bar-row">
        <span class="tmit-bar-label">${s.key}</span>
        <div class="tmit-bar-track">
          <div class="tmit-bar-fill" style="width:${pct}%;background:${statColors[s.key]};"></div>
        </div>
        <span class="tmit-bar-val">${formatStatShort(s.val)}</span>
        ${modStr}
      </div>`;
    }).join('');

    // Cooldowns
    const drugCd    = formatCooldown(bs.drugCd);
    const boosterCd = formatCooldown(bs.boosterCd);
    const medCd     = formatCooldown(bs.medicalCd);
    const cdRows = [
      drugCd    ? `<div class="tmit-result-row"><span class="tmit-result-label">Drug CD</span><span class="tmit-result-val hot">${drugCd}</span></div>` : '',
      boosterCd ? `<div class="tmit-result-row"><span class="tmit-result-label">Booster CD</span><span class="tmit-result-val hot">${boosterCd}</span></div>` : '',
      medCd     ? `<div class="tmit-result-row"><span class="tmit-result-label">Medical CD</span><span class="tmit-result-val hot">${medCd}</span></div>` : '',
    ].filter(Boolean).join('') || '<div class="tmit-result-row"><span class="tmit-result-label">Cooldowns</span><span class="tmit-result-val" style="color:#50dc82">None active ✓</span></div>';

    statsEl.style.display = 'block';
    statsEl.innerHTML = `
      ${statRows}
      <div style="height:6px;"></div>
      <div class="tmit-result-row">
        <span class="tmit-result-label">Total BS</span>
        <span class="tmit-result-val gold">${formatStatShort(bs.total)}</span>
      </div>
      <div class="tmit-result-row">
        <span class="tmit-result-label">Level</span>
        <span class="tmit-result-val">${bs.level}</span>
      </div>
      ${cdRows}
      <div class="tmit-result-row" style="margin-top:4px;">
        <span class="tmit-result-label" style="color:#3a2a5a;">Updated</span>
        <span style="font-size:9px;color:#3a2a5a;font-family:monospace;">${bs.timestamp ? new Date(bs.timestamp).toLocaleTimeString() : '—'}</span>
      </div>
    `;
  }

  function renderStatGains(window) {
    const el = document.getElementById('tmit-sg-result');
    if (!el) return;

    if (statHistory.length < 2) {
      el.style.display = 'block';
      el.innerHTML = '<div style="color:#4a3a6a;font-size:11px;">Need at least 2 stat snapshots. Stats are recorded each time you click ↻ Update.</div>';
      return;
    }

    const count = window === 'all' ? statHistory.length : Math.min(parseInt(window) + 1, statHistory.length);
    const recent = statHistory.slice(-count);
    const first  = recent[0];
    const last   = recent[recent.length - 1];
    const days   = (last.ts - first.ts) / (1000 * 60 * 60 * 24);
    const daysStr = days < 1 ? `${Math.round(days * 24)}h` : `${days.toFixed(1)} days`;

    const gains = {
      str:   last.str   - first.str,
      def:   last.def   - first.def,
      spd:   last.spd   - first.spd,
      dex:   last.dex   - first.dex,
      total: last.total - first.total,
    };

    const perDay = days > 0 ? {
      str:   gains.str   / days,
      def:   gains.def   / days,
      spd:   gains.spd   / days,
      dex:   gains.dex   / days,
      total: gains.total / days,
    } : null;

    el.style.display = 'block';
    el.innerHTML = `
      <div class="tmit-result-row"><span class="tmit-result-label">Period</span><span class="tmit-result-val">${daysStr} (${recent.length - 1} snapshots)</span></div>
      <div class="tmit-result-row"><span class="tmit-result-label">STR gain</span><span class="tmit-result-val hot">${gains.str >= 0 ? '+' : ''}${formatStatShort(gains.str)}</span></div>
      <div class="tmit-result-row"><span class="tmit-result-label">DEF gain</span><span class="tmit-result-val icy">${gains.def >= 0 ? '+' : ''}${formatStatShort(gains.def)}</span></div>
      <div class="tmit-result-row"><span class="tmit-result-label">SPD gain</span><span class="tmit-result-val gold">${gains.spd >= 0 ? '+' : ''}${formatStatShort(gains.spd)}</span></div>
      <div class="tmit-result-row"><span class="tmit-result-label">DEX gain</span><span class="tmit-result-val" style="color:#b080ff">${gains.dex >= 0 ? '+' : ''}${formatStatShort(gains.dex)}</span></div>
      <div class="tmit-result-row"><span class="tmit-result-label">Total gain</span><span class="tmit-result-val green">${gains.total >= 0 ? '+' : ''}${formatStatShort(gains.total)}</span></div>
      ${perDay ? `<div class="tmit-result-row"><span class="tmit-result-label">Per day</span><span class="tmit-result-val">${formatStatShort(perDay.total)}/day</span></div>` : ''}
    `;
  }

  async function doSpyLookup(playerId) {
    const resultEl = document.getElementById('tmit-spy-result');
    if (!resultEl) return null;
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<div style="color:#c9a227;font-family:monospace;font-size:11px;">Looking up…</div>';

    const tsKey  = load('tsKey', '');
    let   spy    = null;

    // Try TornStats first
    if (tsKey) spy = await fetchTornStatsSpy(tsKey, playerId);
    // Then YATA
    if (!spy)  spy = await fetchYataSpy(playerId);

    if (spy) {
      playerCache[playerId] = { spy, level: null, name: spy.name, cachedAt: Date.now() };
      savePlayerCache();
      const age = spy.timestamp ? Math.round((Date.now() - spy.timestamp * 1000) / (1000 * 60 * 60 * 24)) : null;
      resultEl.innerHTML = `
        <div class="tmit-result-row"><span class="tmit-result-label">Source</span><span class="tmit-result-val green">${spy.source} ✓</span></div>
        <div class="tmit-result-row"><span class="tmit-result-label">Player</span><span class="tmit-result-val gold">${spy.name || playerId}</span></div>
        <div class="tmit-result-row"><span class="tmit-result-label">STR</span><span class="tmit-result-val hot">${formatStatShort(spy.str)}</span></div>
        <div class="tmit-result-row"><span class="tmit-result-label">DEF</span><span class="tmit-result-val icy">${formatStatShort(spy.def)}</span></div>
        <div class="tmit-result-row"><span class="tmit-result-label">SPD</span><span class="tmit-result-val gold">${formatStatShort(spy.spd)}</span></div>
        <div class="tmit-result-row"><span class="tmit-result-label">DEX</span><span class="tmit-result-val" style="color:#b080ff">${formatStatShort(spy.dex)}</span></div>
        <div class="tmit-result-row"><span class="tmit-result-label">Total</span><span class="tmit-result-val green">${formatStatShort(spy.total)}</span></div>
        ${age !== null ? `<div class="tmit-result-row"><span class="tmit-result-label">Spy age</span><span class="tmit-result-val">${age} days old</span></div>` : ''}
      `;
      return spy;
    } else {
      // No spy — show level-based estimate
      try {
        const profileData = await apiGet(
          `https://api.torn.com/user/${playerId}?selections=profile&key=${settings.apiKey}&comment=TEEM`
        );
        const level = profileData?.level ?? 0;
        const est   = estimateFromLevel(level);
        playerCache[playerId] = { spy: null, estimate: est, level, name: profileData?.name ?? '', cachedAt: Date.now() };
        savePlayerCache();
        resultEl.innerHTML = `
          <div class="tmit-result-row"><span class="tmit-result-label">Player</span><span class="tmit-result-val gold">${profileData?.name ?? playerId}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Level</span><span class="tmit-result-val">${level}</span></div>
          <div class="tmit-result-row" style="margin-top:4px;"><span class="tmit-result-label">No spy</span><span class="tmit-result-val" style="color:#4a3a6a">Estimated range:</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Total BS</span><span class="tmit-result-val" style="color:#b080ff">${formatStatShort(est.low)} – ${formatStatShort(est.high)}</span></div>
          <div style="font-size:9px;color:#3a2a5a;margin-top:4px;">Range is a rough estimate based on level only. Add a TornStats key for accurate spy data.</div>
        `;
      } catch(e) {
        resultEl.innerHTML = '<div style="color:#ff6060;font-size:11px;">Could not fetch player data.</div>';
      }
      return null;
    }
  }

  function doSpyCompare(spy) {
    const resultEl = document.getElementById('tmit-compare-result');
    if (!resultEl || !myBattleStats) return;
    resultEl.style.display = 'block';

    const me = myBattleStats;
    const stats = ['str','def','spd','dex'];
    const labels = { str:'STR', def:'DEF', spd:'SPD', dex:'DEX' };
    const colors = { str:'#e8621a', def:'#3dd6c8', spd:'#c9a227', dex:'#b080ff' };

    const rows = stats.map(s => {
      const diff = me[s] - spy[s];
      const pct  = spy[s] > 0 ? Math.round((diff / spy[s]) * 100) : 0;
      const sign = diff >= 0 ? '+' : '';
      const col  = diff >= 0 ? '#50dc82' : '#ff6060';
      return `<div class="tmit-result-row">
        <span class="tmit-result-label">${labels[s]}</span>
        <span class="tmit-result-val" style="color:${colors[s]}">${formatStatShort(me[s])}</span>
        <span style="font-size:9px;color:${col};font-family:monospace;margin-left:4px;">${sign}${formatStatShort(diff)} (${sign}${pct}%)</span>
      </div>`;
    }).join('');

    const totalDiff = me.total - spy.total;
    const totalSign = totalDiff >= 0 ? '+' : '';
    const totalCol  = totalDiff >= 0 ? '#50dc82' : '#ff6060';

    resultEl.innerHTML = `
      <div class="tmit-result-row"><span class="tmit-result-label">vs</span><span class="tmit-result-val gold">${spy.name || 'Target'}</span></div>
      ${rows}
      <div class="tmit-result-row" style="margin-top:4px;border-top:1px solid rgba(201,162,39,0.15);padding-top:4px;">
        <span class="tmit-result-label">Total</span>
        <span class="tmit-result-val">${formatStatShort(me.total)}</span>
        <span style="font-size:9px;color:${totalCol};font-family:monospace;margin-left:4px;">${totalSign}${formatStatShort(totalDiff)}</span>
      </div>
      <div style="font-size:9px;color:#3a2a5a;margin-top:4px;">Positive = you are stronger. Negative = they are stronger.</div>
    `;
  }

  // Parse pasted spy report text
  function parseSpyText(text) {
    const extract = (label) => {
      const p1 = new RegExp(label + '[:\\s]+([0-9,.]+[BMKTbmkt]?)', 'i');
      const p2 = new RegExp(label + '[^0-9]*([0-9,]+)', 'i');
      for (const pat of [p1, p2]) {
        const m = text.match(pat);
        if (m) {
          const raw = m[1].replace(/,/g, '');
          const n = parseFloat(raw);
          if (/t/i.test(raw)) return n * 1e12;
          if (/b/i.test(raw)) return n * 1e9;
          if (/m/i.test(raw)) return n * 1e6;
          if (/k/i.test(raw)) return n * 1e3;
          return n;
        }
      }
      return 0;
    };
    const nameMatch = text.match(/(?:name|player)[^a-z]*([^\n\r]+)/i);
    return {
      source:    'Pasted',
      name:      nameMatch ? nameMatch[1].trim() : 'Target',
      str:       extract('strength') || extract('str'),
      def:       extract('defense')  || extract('def'),
      spd:       extract('speed')    || extract('spd'),
      dex:       extract('dexterity')|| extract('dex'),
      get total() { return this.str + this.def + this.spd + this.dex; },
      timestamp: 0,
    };
  }

  // ── Travel Tab ────────────────────────────────────────────────────────────

  function renderTravelTab() {
    const listEl = document.getElementById('tmit-travel-list');
    if (!listEl) return;

    if (!travelRanking.length) {
      listEl.innerHTML = `<div class="tmit-state-msg">
        <div class="tmit-state-icon">✈</div>
        Waiting for market data. Hit ↻ to force a refresh.
      </div>`;
      return;
    }

    const rows = travelRanking.map((r, i) => {
      const rankClass = i === 0 ? 'rank1' : i === 1 ? 'rank2' : i === 2 ? 'rank3' : '';
      const pphClass  = i === 0 ? 'tmit-travel-pph top' : 'tmit-travel-pph';
      const stockPct  = r.bestItem ? Math.round(r.bestItem.stockLevel * 100) : 100;
      const stockConf = r.bestItem?.stockConf ?? 'assumed';
      const stockTxt  = stockConf === 'yata' ? `${stockPct}% ✓` : '~stock';

      return `<div class="tmit-travel-row ${rankClass}" data-code="${r.code}">
        <div class="tmit-travel-flag">${r.flagEmoji}</div>
        <div>
          <div class="tmit-travel-dest">${r.country}</div>
          <div class="tmit-travel-sub">${r.bestItem?.name ?? '—'}</div>
        </div>
        <div class="${pphClass}">${formatPPH(r.profitPerHour)}</div>
        <div class="tmit-travel-time">${getAdjustedTravelTime(r.travelTime)}m ea</div>
        <div class="tmit-travel-stock ${stockConf}">${stockTxt}</div>
      </div>`;
    });

    listEl.innerHTML = rows.join('');

    // Click to expand detail
    listEl.querySelectorAll('.tmit-travel-row').forEach(row => {
      row.addEventListener('click', () => {
        const code = row.dataset.code;
        const r = travelRanking.find(x => x.code === code);
        if (!r) return;
        const detailEl = document.getElementById('tmit-travel-detail');
        if (!detailEl) return;
        const item = r.bestItem;
        detailEl.innerHTML = `<div class="tmit-travel-detail-card">
          <div class="tmit-result-row"><span class="tmit-result-label">${r.flagEmoji} Destination</span><span class="tmit-result-val gold">${r.country}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Best Item</span><span class="tmit-result-val">${item?.name ?? '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Buy Price (abroad)</span><span class="tmit-result-val icy">$${item?.buyPrice?.toLocaleString() ?? '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Market Price</span><span class="tmit-result-val hot">$${item?.sellPrice?.toLocaleString() ?? '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">After 5% Tax</span><span class="tmit-result-val hot">$${item?.netSellPrice?.toLocaleString() ?? '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Profit / Item</span><span class="tmit-result-val green">$${item?.profitPerItem?.toLocaleString() ?? '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Carry (effective)</span><span class="tmit-result-val">${item?.actualCap ?? '—'} items</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Total Profit</span><span class="tmit-result-val green">$${item ? Math.round(item.profitPerItem * item.actualCap).toLocaleString() : '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Flight Type</span><span class="tmit-result-val gold">${({'economy':'Economy','airstrip':'Airstrip -30%','business':'Business -50%','wlt':'WLT -50%'})[settings.flightType] ?? 'Economy'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">One-way time</span><span class="tmit-result-val">${getAdjustedTravelTime(r.travelTime)} min</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Round Trip</span><span class="tmit-result-val">${r.roundTripHours.toFixed(1)} hrs</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Profit / Hour</span><span class="tmit-result-val gold">${formatPPH(r.profitPerHour)}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Stock Data</span><span class="tmit-result-val ${item?.stockConf === 'yata' ? 'green' : ''}">${item?.stockConf === 'yata' ? 'YATA ✓' : 'Assumed full'}</span></div>
        </div>`;
      });
    });
  }

  // ── War Gear Tab ──────────────────────────────────────────────────────────

  function populateWarItemDropdown(filter = '') {
    const sel = document.getElementById('tmit-war-item-select');
    if (!sel) return;

    // Use isRWItem and RW_KNOWN_WEAPONS — the single source of truth
    // These correctly handle all Torn API type string variations
    let warItems = Object.values(itemMeta)
      .filter(m => m.name && isRWItem(m.name, m.type))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Apply search filter if provided
    if (filter) {
      warItems = warItems.filter(m =>
        m.name.toLowerCase().includes(filter.toLowerCase())
      );
    }

    if (!warItems.length) {
      sel.innerHTML = filter
        ? `<option value="">— No match for "${filter}" —</option>`
        : '<option value="">— No data yet — wait for first poll —</option>';
      return;
    }

    const currentVal = sel.value;
    sel.innerHTML = '<option value="">— Pick an item —</option>'
      + warItems.map(m => {
          const wt = classifyWeaponType(m.name, m.type) ?? m.type;
          return `<option value="${m.name}" data-type="${wt ?? ''}">${m.name} (${m.type})</option>`;
        }).join('');

    if (currentVal) sel.value = currentVal;
  }

  function renderQuickTab() {
    const listEl = document.getElementById('tmit-quick-list');
    if (!listEl) return;
    if (!quickItems.length) {
      listEl.innerHTML = '<div style="font-size:10px;color:#3a2a5a;padding:8px 0;">No items saved yet. Add some above.</div>';
      return;
    }
    listEl.innerHTML = quickItems.map((item, idx) => `
      <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;
                  background:rgba(0,0,0,0.25);border-radius:6px;border:1px solid rgba(201,162,39,0.12);">
        <span style="flex:1;font-size:11px;color:#d8c8f0;">${item.name}</span>
        <button data-quick-remove="${idx}"
          style="font-size:10px;color:#ff6060;background:none;border:none;cursor:pointer;
                 padding:2px 6px;opacity:0.7;">✕ Remove</button>
      </div>
    `).join('');
  }

  function renderWarTab() {
    const listEl = document.getElementById('tmit-war-tracker-list');
    if (!listEl) return;

    // Build war item list from itemMeta (all known items) merged with
    // analysisCache prices where available — so guns without price history still show
    const priceMap = {};
    for (const r of analysisCache) priceMap[r.name] = r.currentPrice;

    const warItems = Object.values(itemMeta)
      .filter(m => isRWItem(m.name, m.type))
      .map(m => ({
        name:         m.name,
        type:         m.type,
        currentPrice: priceMap[m.name] ?? m.market_value ?? 0,
      }));

    if (warItems.length === 0) {
      listEl.innerHTML = `<div class="tmit-state-msg" style="padding:16px 0;">
        <div class="tmit-state-icon" style="font-size:20px">⚔</div>
        No war gear detected yet in market data.<br>
        <span style="font-size:10px;color:#3a2a5a">War weapons and armor will appear here as price history accumulates.</span>
      </div>`;
      return;
    }

    // Sort by current price descending (most valuable first)
    const sorted = [...warItems].sort((a, b) => b.currentPrice - a.currentPrice);

    const rows = sorted.map(r => {
      // Determine rarity from market price ranges (rough heuristic)
      // Yellow < ~50M, Orange 50M–500M, Red > 500M
      const price = r.currentPrice;
      const rarity = price > 500_000_000 ? 'red'
                   : price > 50_000_000  ? 'orange'
                   : price > 0           ? 'yellow' : '';

      const changeClass = r.changePct > 0 ? 'tmit-change up'
                        : r.changePct < 0 ? 'tmit-change down' : 'tmit-change flat';
      const changeSign  = r.changePct > 0 ? '+' : '';

      const weapType = classifyWeaponType(r.name, r.type);
      const bbVal    = rarity ? getBBValue(rarity, 1, weapType) : 0;
      const bbDollar = bbVal > 0 ? `$${Math.round(bbVal * bbPerDollar / 1_000_000)}M` : '—';

      // Rarity dot indicator
      const rarityDot = rarity === 'red'    ? '<span style="color:#ff4040;font-size:8px">●</span> '
                      : rarity === 'orange' ? '<span style="color:#e8621a;font-size:8px">●</span> '
                      : rarity === 'yellow' ? '<span style="color:#ffe066;font-size:8px">●</span> '
                      : '';

      return `<div class="tmit-war-row ${rarity ? rarity+'-item' : ''}">
        <div>
          <div class="tmit-war-name" title="${r.name}">${rarityDot}${r.name}</div>
          <div style="font-size:9px;color:#3a2a5a">${r.type}${weapType ? ' · '+weapType : ''}</div>
        </div>
        <div class="tmit-war-price" style="text-align:right">$${r.currentPrice >= 1_000_000
          ? (r.currentPrice/1_000_000).toFixed(1)+'M'
          : r.currentPrice.toLocaleString()}</div>
        <div class="tmit-war-bb" style="text-align:right">${bbVal ? bbVal+' BB' : '—'}</div>
        <div style="text-align:right;font-size:10px;color:#50dc82">${bbDollar}</div>
        <div class="${changeClass}" style="text-align:right">${changeSign}${r.changePct}%</div>
      </div>`;
    });

    listEl.innerHTML = rows.join('');
  }

  // ── BB Calculator Tab ──────────────────────────────────────────────────────

  function renderList() {
    const listEl = document.getElementById('tmit-list');
    if (!listEl) return;

    const results = runAnalysis();
    const search  = document.getElementById('tmit-search')?.value.toLowerCase() ?? '';
    const budget  = settings.maxBudget;
    const minPct  = settings.minProfit;
    const cat     = settings.selectedCategory;
    const isWatchTab = settings.activeTab === 'watchlist';

    // Sync active tab UI
    document.querySelectorAll('.tmit-tab').forEach(t => {
      t.classList.toggle('tmit-tab-active', t.dataset.tab === (settings.activeTab || 'all'));
    });

    let filtered = results.filter(r => {
      if (isWatchTab && !watchlist.has(r.itemId)) return false;
      if (search && !r.name.toLowerCase().includes(search)) return false;
      if (cat !== 'All' && r.type !== cat) return false;
      if (budget > 0 && r.currentPrice > budget) return false;
      if (minPct > 0 && Math.abs(r.changePct) < minPct) return false;
      return true;
    });

    if (filtered.length === 0) {
      let msg;
      if (isWatchTab) {
        msg = `<div class="tmit-state-msg"><div class="tmit-state-icon">⭐</div>Your watchlist is empty.<br><span style="font-size:11px">Click any <b style="color:#80b0ff">WATCH</b> badge on the All Items tab to pin it here.</span></div>`;
      } else if (Object.keys(priceHistory).length === 0) {
        msg = `<div class="tmit-state-msg"><div class="tmit-state-icon">⏳</div>Collecting data… check back after the first poll completes.</div>`;
      } else {
        msg = `<div class="tmit-state-msg"><div class="tmit-state-icon">🔍</div>No items match your filters.</div>`;
      }
      listEl.innerHTML = msg;
      document.getElementById('tmit-item-count').textContent = 0;
      return;
    }

    const rows = filtered.map(r => {
      const changeClass = r.changePct > 0 ? 'up' : r.changePct < 0 ? 'down' : 'flat';
      const changeSign  = r.changePct > 0 ? '+' : '';
      // Hot/icy row classes based on direction of change
      let rowClass = 'tmit-item-row';
      let spikeIcon = '';
      if (r.changePct >= 30)       { rowClass = 'tmit-item-row tmit-hot-big'; spikeIcon = '🔥'; }
      else if (r.changePct >= 15)  { rowClass = 'tmit-item-row tmit-hot';     spikeIcon = '🔥'; }
      else if (r.changePct > 0)    { rowClass = 'tmit-item-row tmit-hot'; }
      else if (r.changePct <= -30) { rowClass = 'tmit-item-row tmit-icy-big'; spikeIcon = '🧊'; }
      else if (r.changePct <= -15) { rowClass = 'tmit-item-row tmit-icy';     spikeIcon = '🧊'; }
      else if (r.changePct < 0)    { rowClass = 'tmit-item-row tmit-icy'; }
      const confDots    = [1,2,3].map(i =>
        `<div class="tmit-conf-dot${i <= r.confidence ? ' filled' : ''}"></div>`
      ).join('');

      const isPinned   = watchlist.has(r.itemId);
      const finalClass = rowClass + (isPinned ? ' tmit-pinned' : '');
      const watchedCls = (r.signal === 'WATCH' && isPinned) ? ' tmit-watched' : '';

      return `
        <div class="${finalClass}" data-item-id="${r.itemId}">
          <div>
            <div class="tmit-item-name">
              ${spikeIcon ? `<span class="tmit-spike-icon">${spikeIcon}</span>` : ''}${r.name}
            </div>
            <div class="tmit-item-type">${r.type}</div>
          </div>
          <div class="tmit-price">$${r.currentPrice.toLocaleString()}</div>
          <div class="tmit-change ${changeClass}">${changeSign}${r.changePct}%</div>
          <div class="tmit-signal">
            <span class="tmit-signal-badge ${r.signal}${watchedCls}">${r.signal}</span>
            <div class="tmit-confidence-bar" style="justify-content:flex-end;margin-top:2px">${confDots}</div>
          </div>
          <div style="display:flex;gap:3px;align-items:center;">
            <button class="tmit-row-btn tmit-pin-row" data-id="${r.itemId}"
              title="${isPinned ? 'Remove from watchlist' : 'Add to watchlist'}"
              style="color:${isPinned ? '#c9a227' : 'rgba(201,162,39,0.3)'};">★</button>
            <button class="tmit-row-btn tmit-buy-btn" data-id="${r.itemId}" data-name="${r.name}" data-cat="${r.type}"
              title="Buy on market">🛒</button>
          </div>
        </div>`;
    });

    listEl.innerHTML = rows.join('');
    document.getElementById('tmit-item-count').textContent = filtered.length;
    updateWatchCount();
  }

  function checkTravelAlerts() {
    if (!travelRanking.length) return;
    const top = travelRanking[0];

    // Only alert at :00, :15, :30, :45 boundaries
    const now     = new Date();
    const minutes = now.getMinutes();
    const onQuarter = minutes % 15 === 0;
    if (!onQuarter) return;

    // Only alert if this is a new destination OR profit improved by 25%+
    const changed  = top.code !== lastTopTravelCode;
    const improved = top.profitPerHour > lastTopTravelPPH * 1.25;
    if (!changed && !improved) return;

    // Don't repeat the same alert within the same 15-min window
    const windowKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${Math.floor(minutes/15)}`;
    const lastAlertWindow = load('lastTravelAlertWindow', '');
    if (windowKey === lastAlertWindow) return;

    // ── Cooldown checks ──────────────────────────────────────────────────
    if (settings.alertOnDrugClear && myBattleStats?.drugCd > 0) return;
    if (settings.alertOnBoosterClear && myBattleStats?.boosterCd > 0) return;

    // ── Stock check ──────────────────────────────────────────────────────
    if (settings.alertRequireStock && top.bestItem) {
      const stockLevel = top.bestItem.stockLevel ?? 1;
      if (stockLevel < 0.1) return
    }

    // ── Build notification body ──────────────────────────────────────────
    const mult     = getFlightMultiplier();
    const oneWay   = getAdjustedTravelTime(top.travelTime);
    const flightLabel = {
      economy: 'Economy', airstrip: 'Airstrip',
      business: 'Business Class', wlt: 'WLT'
    }[settings.flightType] ?? 'Economy';

    const stockStr = top.bestItem?.stockConf === 'yata'
      ? ` · Stock: ${Math.round((top.bestItem.stockLevel ?? 1) * 100)}%`
      : '';

    const cdStr = [];
    if (myBattleStats?.drugCd > 0)    cdStr.push('Drug CD: ' + formatCooldown(myBattleStats.drugCd));
    if (myBattleStats?.boosterCd > 0) cdStr.push('Booster CD: ' + formatCooldown(myBattleStats.boosterCd));

    const body = [
      `${top.flagEmoji} ${top.country} — ${formatPPH(top.profitPerHour)}`,
      `${top.bestItem?.itemName ?? ''} · ${flightLabel} · ${oneWay}min each way${stockStr}`,
      cdStr.length ? cdStr.join(' · ') : 'No active cooldowns ✓',
    ].join('\n');

    lastTopTravelCode = top.code;
    lastTopTravelPPH  = top.profitPerHour;
    store('lastTravelCode', lastTopTravelCode);
    store('lastTravelPPH',  lastTopTravelPPH);
    store('lastTravelAlertWindow', windowKey);

    try {
      new Notification('TEEM ✈ Good Time to Fly!', { body, icon: '', silent: false });
    } catch(e) {}
  }

  function recomputeTravel() {
    const capacity = settings.carryCapacity || 10;
    // Build market prices: price history first, then YATA, then market_value
    const marketPrices = {};
    // Start with market_value from itemMeta as baseline
    for (const [idStr, m] of Object.entries(itemMeta)) {
      if (String(idStr).startsWith('rw_')) continue;
      const id = parseInt(idStr);
      if (m.market_value > 0) marketPrices[id] = m.market_value;
    }
    // Layer YATA prices on top
    for (const [idStr, price] of Object.entries(lastYataPrices)) { if (price > 0) marketPrices[parseInt(idStr)] = price; }
    // Layer live price history on top (most accurate)
    for (const [idStr, hist] of Object.entries(priceHistory)) {
      if (hist.length) {
        const latest = hist[hist.length - 1];
        const p = latest.price || latest.yataPrice || 0;
        if (p > 0) marketPrices[parseInt(idStr)] = p;
      }
    }
    travelRanking = rankTravelDestinations(marketPrices, yataStockCache, capacity);
    checkTravelAlerts();
  }

  function exportCurrentView() {
    const tab = settings.activeTab || 'all';
    let rows = [], headers = [];

    if (tab === 'all' || tab === 'watchlist') {
      headers = ['Item','Type','Price','Change%','Signal','Confidence','Data Sources'];
      rows = analysisCache
        .filter(r => tab === 'watchlist' ? watchlist.has(r.itemId) : true)
        .map(r => [r.name, r.type, r.currentPrice, r.changePct, r.signal, r.confidence, r.dataSources]);
    } else if (tab === 'travel') {
      headers = ['Rank','Country','Item','Buy Price','Sell Price','Profit/Item','Carry','Total Profit','Round Trip hrs','Profit/Hr','Stock Confidence'];
      rows = travelRanking.map((r,i) => [
        i+1, r.country, r.bestItem?.itemName ?? '—',
        r.bestItem?.buyPrice ?? 0, r.bestItem?.netSellPrice ?? 0,
        r.bestItem?.profitPerItem ?? 0, r.bestItem?.actualCap ?? 0,
        r.bestItem ? Math.round(r.bestItem.profitPerItem * r.bestItem.actualCap) : 0,
        r.roundTripHours.toFixed(1), r.profitPerHour, r.bestItem?.stockConf ?? '—'
      ]);
    } else if (tab === 'bb') {
      headers = ['Cache','BB Cost','Dollar Value'];
      rows = Object.entries(BB_CACHE_COSTS).map(([name, cost]) => [
        name, cost, Math.round(cost * bbPerDollar)
      ]);
    } else if (tab === 'war') {
      headers = ['Item','Type','Price','BB Value','Dollar Equiv','Change%'];
      const warTypes = new Set(['Melee','Piercing','Slashing','Clubbing','Mechanical','Pistol','SMG','Shotgun','Rifle','Machine gun','Heavy artillery','Armor','Armour']);
      rows = analysisCache
        .filter(r => warTypes.has(r.type))
        .map(r => {
          const wt = classifyWeaponType(r.name, r.type);
          const price = r.currentPrice;
          const rarity = price > 500_000_000 ? 'red' : price > 50_000_000 ? 'orange' : 'yellow';
          const bb = getBBValue(rarity, 1, wt);
          return [r.name, r.type, r.currentPrice, bb, Math.round(bb * bbPerDollar), r.changePct];
        });
    }

    if (!rows.length) {
      // Show brief feedback
      const btn = document.getElementById('tmit-btn-export');
      if (btn) { btn.textContent = '✗ No data'; setTimeout(() => btn.textContent = '⬇ CSV', 1500); }
      return;
    }

    const csv = [headers, ...rows].map(r => r.map(v =>
      typeof v === 'string' && v.includes(',') ? `"${v}"` : v
    ).join(',')).join('\n');

    try {
      navigator.clipboard.writeText(csv).then(() => {
        const btn = document.getElementById('tmit-btn-export');
        if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '⬇ CSV', 2000); }
      });
    } catch(e) {
      // Fallback: create download
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `teem-${tab}-${Date.now()}.csv`; a.click();
      URL.revokeObjectURL(url);
    }
  }

  function updateSessionTracker() {
    const invEl    = document.getElementById('tmit-sess-inv');
    const profitEl = document.getElementById('tmit-sess-profit');
    const ageDotEl = document.getElementById('tmit-age-dot');
    const ageTextEl = document.getElementById('tmit-age-text');

    // Inventory value estimate from price history
    let invVal = 0;
    for (const [idStr, hist] of Object.entries(priceHistory)) {
      if (!hist.length) continue;
      const latest = hist[hist.length - 1];
      const price = latest.price || latest.yataPrice || 0;
      if (price > 0) {
        const startPrice = sessionStartPrices[idStr] ?? price;
        if (!sessionStartPrices[idStr]) sessionStartPrices[idStr] = price;
        sessionProfit += (price - startPrice);
      }
    }

    // Rough inventory value = sum of latest prices of watched items
    let watchedVal = 0;
    for (const id of watchlist) {
      const hist = priceHistory[id];
      if (hist?.length) {
        const latest = hist[hist.length - 1];
        watchedVal += (latest.price || latest.yataPrice || 0);
      }
    }

    if (invEl) invEl.textContent = watchedVal > 0
      ? `$${(watchedVal/1_000_000).toFixed(1)}M` : '—';

    if (profitEl) {
      const sign = sessionProfit >= 0 ? '+' : '';
      profitEl.textContent = `${sign}$${Math.abs(sessionProfit) >= 1_000_000
        ? (sessionProfit/1_000_000).toFixed(1)+'M'
        : Math.round(sessionProfit).toLocaleString()}`;
      profitEl.className = `tmit-session-val ${sessionProfit >= 0 ? 'positive' : 'hot'}`;
    }

    // Data age indicator
    const lastPoll = Object.values(priceHistory).reduce((newest, hist) => {
      if (!hist.length) return newest;
      return Math.max(newest, hist[hist.length-1].ts);
    }, 0);

    if (lastPoll && ageDotEl && ageTextEl) {
      const ageSec = Math.floor((Date.now() - lastPoll) / 1000);
      if (ageSec < 90)       { ageDotEl.className = 'tmit-age-dot tmit-age-fresh'; ageTextEl.textContent = `${ageSec}s ago`; }
      else if (ageSec < 600) { ageDotEl.className = 'tmit-age-dot tmit-age-stale'; ageTextEl.textContent = `${Math.floor(ageSec/60)}m ago`; }
      else                   { ageDotEl.className = 'tmit-age-dot tmit-age-old';   ageTextEl.textContent = `${Math.floor(ageSec/60)}m ago`; }
    }
  }

  function updateWatchCount() {
    const el = document.getElementById('tmit-watch-count');
    if (el) el.textContent = watchlist.size;
  }

  function setStatus(type, text) {
    const el = document.getElementById('tmit-status');
    if (!el) return;
    el.textContent = text;
    el.className = 'tmit-status-pill' + (type === 'ok' ? ' tmit-ok' : type === 'err' ? ' tmit-err' : '');
  }

  function updateFooter() {
    updateSessionTracker();
    const snapshots = Object.values(priceHistory).reduce((a, v) => a + v.length, 0);
    const itemCount = document.getElementById('tmit-item-count');
    const snapEl    = document.getElementById('tmit-snapshot-count');
    const nextEl    = document.getElementById('tmit-next-poll');
    if (snapEl) snapEl.textContent = snapshots.toLocaleString();
    if (nextEl) nextEl.textContent = '~1m';
  }

  // ── Drag ──────────────────────────────────────────────────────────────────────

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, startX = 0, startY = 0;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;

      function onMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = Math.max(0, ox + dx) + 'px';
        el.style.top    = Math.max(0, oy + dy) + 'px';
      }

      function onUp(e) {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        settings.posX = parseInt(el.style.left);
        settings.posY = parseInt(el.style.top);
        saveSettings();
      }

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  function init() {
    buildUI();

    // Keyboard shortcut Alt+T to toggle panel
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 't') {
        const panel = document.getElementById('tmit-panel');
        const fab   = document.getElementById('tmit-fab');
        if (panel && fab) {
          if (panel.classList.contains('tmit-hidden')) openPanel(fab, panel);
          else panel.classList.add('tmit-hidden');
        }
      }
    });

    // Notification permission request (needed for travel + spike alerts)
    if (Notification.permission === 'default') { Notification.requestPermission(); }

    // Show onboarding for new users, otherwise start polling
    if (!onboardingDone || !settings.apiKey) {
      const fabImg = document.querySelector('#tmit-fab img');
      const iconSrc = fabImg ? fabImg.src : '';
      buildOnboarding(iconSrc);
    } else {
      // ── Instant render from cache ──────────────────────────────────────
      // Render immediately from whatever is in memory (loaded from GM storage
      // at script start) so the market list appears instantly on page load.
      // The background poll will update prices and show a fresh timestamp.
      if (Object.keys(priceHistory).length > 0) {
        // Resolve travel IDs from cached itemMeta before recomputing travel
        if (Object.keys(itemMeta).length > 0) {
          resolveTravelItemIds(
            Object.fromEntries(
              Object.entries(itemMeta)
                .filter(([id]) => !String(id).startsWith('rw_'))
                .map(([id, m]) => [id, { name: m.name, type: m.type }])
            )
          );
        }
        runAnalysis();
        renderList();
        recomputeTravel();
        // Rebuild categories from cached itemMeta
        const seenTypes = new Set(['All']);
        for (const m of Object.values(itemMeta)) { if (m.type) seenTypes.add(m.type); }
        CATEGORIES = ['All', ...Array.from(seenTypes).filter(t => t !== 'All').sort()];
        const catSelect = document.getElementById('tmit-cat-select');
        if (catSelect) {
          const currentVal = settings.selectedCategory || 'All';
          catSelect.innerHTML = CATEGORIES.map(c =>
            `<option value="${c}"${c === currentVal ? ' selected' : ''}>${c}</option>`
          ).join('');
        }
        setStatus('ok', `Cached · ${new Date().toLocaleTimeString()}`);
      }
      // Start polling in background — updates prices without blocking UI
      startPolling();
    }

    // Session tracker update loop
    setInterval(updateSessionTracker, 15000);

    // Start page injector for stat badges
    startInjector();

    // Fetch my own battlestats on startup (silently)
    if (settings.apiKey) { setTimeout(() => fetchMyBattleStats(settings.apiKey), 3000); }
  }

  // ── Page injector — stat badges next to player names ─────────────────────

  // Rate-limit concurrent API calls for badge injection
  const _badgeQueue = { pending: new Set(), inFlight: 0, maxFlight: 3 };

  async function _processBadgeQueue() {
    if (_badgeQueue.inFlight >= _badgeQueue.maxFlight) return;
    for (const fn of _badgeQueue.pending) {
      if (_badgeQueue.inFlight >= _badgeQueue.maxFlight) break;
      _badgeQueue.pending.delete(fn);
      _badgeQueue.inFlight++;
      fn().finally(() => { _badgeQueue.inFlight--;
        _processBadgeQueue(); });
    }
  }

  function injectStatBadges() {
    if (!settings.apiKey) return;

    // Match both formats Torn uses: profiles.php?XID= and profiles.php#XID=
    const links = document.querySelectorAll(
      'a[href*="profiles.php?XID="], a[href*="profiles.php#XID="]'
    );

    links.forEach((link) => {
      // Extract player ID from href
      const match = (link.href || '').match(/XID=(\d+)/i);
      if (!match) return;
      const playerId = match[1];

      // Skip own profile or NPCs
      if (myBattleStats?.playerId && playerId === String(myBattleStats.playerId)) return;
      if (parseInt(playerId) < 1) return;

      // Check if badge actually exists in DOM (SPA may have re-rendered it away)
      const existingBadge = link.parentNode?.querySelector('.teem-stat-badge[data-pid="' + playerId + '"]');
      if (existingBadge) return

      link.dataset.teemBadged = '1';

      // If already cached, attach immediately without API call
      if (playerCache[playerId]) { attachBadge(link, playerId);
        return; }

      // Queue fetch
      _badgeQueue.pending.add(async () => {
        try {
          const tsKey   = load('tsKey',   '');
          const yataKey = load('yataKey', '');
          let spy = null;

          if (tsKey)   spy = await fetchTornStatsSpy(tsKey, playerId);
          if (!spy && yataKey) spy = await fetchYataSpy(playerId);
          if (!spy)    spy = await fetchYataSpy(playerId)

          if (spy && spy.total > 0) {
            playerCache[playerId] = { spy, level: null, name: spy.name, cachedAt: Date.now() };
            savePlayerCache();
          } else {
            // Level-based estimate
            const pd = await apiGet(
              `https://api.torn.com/user/${playerId}?selections=profile&key=${settings.apiKey}&comment=TEEM`
            );
            if (pd && !pd.error) {
              const level = pd.level ?? 0;
              playerCache[playerId] = {
                spy: null,
                estimate: estimateFromLevel(level),
                level,
                name: pd.name ?? '',
                cachedAt: Date.now(),
              };
              savePlayerCache();
            }
          }
          // Re-find the link (DOM may have changed) and attach
          const freshLink = document.querySelector(`a[href*="XID=${playerId}"]`);
          if (freshLink) attachBadge(freshLink, playerId);
        } catch(e) { /* silent fail */ }
      });
      _processBadgeQueue();
    });
  }

  function attachBadge(link, playerId) {
    const cached = playerCache[playerId];
    if (!cached) return;

    // Don't double-badge — check all siblings not just nextSibling
    const parent = link.parentNode;
    if (!parent) return;
    if (parent.querySelector('.teem-stat-badge[data-pid="' + playerId + '"]')) return;

    const badge = document.createElement('span');
    badge.dataset.pid = playerId;

    if (cached.spy && cached.spy.total > 0) {
      badge.className = 'teem-stat-badge spy-exact';
      const ageStr = cached.spy.timestamp
        ? '\nAge: ' + Math.round((Date.now() - cached.spy.timestamp * 1000) / 86400000) + ' days old'
        : '';
      const tip = 'Source: ' + cached.spy.source
        + '\nSTR: ' + formatStatShort(cached.spy.str)
        + '\nDEF: ' + formatStatShort(cached.spy.def)
        + '\nSPD: ' + formatStatShort(cached.spy.spd)
        + '\nDEX: ' + formatStatShort(cached.spy.dex)
        + '\nTotal: ' + formatStatShort(cached.spy.total)
        + ageStr;
      badge.dataset.tip = tip;
      badge.innerHTML = '<img class="teem-icon" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E🐘%3C/text%3E%3C/svg%3E" alt="🐘" draggable="false"><span class="teem-badge-label">' + formatStatShort(cached.spy.total) + '</span>';
    } else if (cached.estimate) {
      badge.className = 'teem-stat-badge spy-range';
      const tip = 'Lv.' + cached.level + ' — no spy data'
        + '\nVery rough range: ' + formatStatShort(cached.estimate.low)
        + ' – ' + formatStatShort(cached.estimate.high)
        + '\n\u26a0 No spy report found for this player.'
        + '\nSpy coverage depends on your faction\'s history.';
      badge.dataset.tip = tip;
      badge.innerHTML = '<img class="teem-icon" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22%3E%3Ctext y=%22.9em%22 font-size=%2290%22%3E🐘%3C/text%3E%3C/svg%3E" alt="🐘" draggable="false"><span class="teem-badge-label">?</span>';
    } else { return; }

    // Insert right after the link element
    if (link.nextSibling) { parent.insertBefore(badge, link.nextSibling); } else { parent.appendChild(badge); }
  }

  // Global tooltip — single div on body, never clipped by ancestors
  (function() {
    const globalTip = document.createElement('div');
    globalTip.id = 'teem-global-tip';
    document.body.appendChild(globalTip);

    document.addEventListener('mouseover', (e) => {
      const badge = e.target.closest('.teem-stat-badge');
      if (!badge || !badge.dataset.tip) return;

      globalTip.textContent = badge.dataset.tip;
      // Show off-screen first to measure real dimensions
      globalTip.style.left = '-9999px';
      globalTip.style.top  = '-9999px';
      globalTip.classList.add('visible');

      const rect   = badge.getBoundingClientRect();
      const tipW   = globalTip.offsetWidth;
      const tipH   = globalTip.offsetHeight;
      const margin = 10;
      const vw     = window.innerWidth;
      const vh     = window.innerHeight;

      // Default: below and left-aligned to badge
      let top  = rect.bottom + margin;
      let left = rect.left;

      // Flip above if not enough room below
      if (top + tipH + margin > vh) top = rect.top - tipH - margin;
      // Ensure top is never negative
      if (top < margin) top = margin;
      // Clamp right overflow
      if (left + tipW + margin > vw) left = vw - tipW - margin;
      // Clamp left overflow
      if (left < margin) left = margin;

      globalTip.style.left = left + 'px';
      globalTip.style.top  = top  + 'px';
    });

    document.addEventListener('mouseout', (e) => {
      if (!e.target.closest('.teem-stat-badge')) return;
      globalTip.classList.remove('visible');
    });
  })();

  // Run injector on page load and on DOM changes (Torn is a SPA)
  function injectQuickBar() {
    if (!window.location.href.includes('item.php')) return;
    if (document.getElementById('teem-quick-bar')) return;
    if (!quickItems.length) return;

    const bar = document.createElement('div');
    bar.id = 'teem-quick-bar';
    bar.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);'
      + 'z-index:99999;display:flex;align-items:center;gap:8px;padding:8px 14px;'
      + 'background:rgba(13,5,32,0.96);border:1px solid rgba(201,162,39,0.3);'
      + 'border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.6);font-family:monospace;'
      + 'max-width:90vw;flex-wrap:wrap;';

    bar.innerHTML = '<span style="font-size:9px;color:#6a5a8a;font-weight:700;'
      + 'text-transform:uppercase;letter-spacing:0.08em;white-space:nowrap;">⚡ Quick Use</span>'
      + quickItems.map(item =>
          '<button class="teem-quick-btn" data-item="' + item.name + '" '
          + 'style="background:rgba(201,162,39,0.12);border:1px solid rgba(201,162,39,0.25);'
          + 'border-radius:5px;color:#e8dff5;font-size:11px;padding:4px 10px;cursor:pointer;'
          + 'font-family:monospace;white-space:nowrap;">' + item.name + '</button>'
        ).join('')
      + '<button id="teem-quick-bar-close" style="background:none;border:none;color:#4a3a6a;'
      + 'cursor:pointer;font-size:14px;padding:0 3px;margin-left:4px;">✕</button>';

    document.body.appendChild(bar);

    bar.querySelector('#teem-quick-bar-close')?.addEventListener('click', () => bar.remove());

    bar.addEventListener('click', async (e) => {
      const btn = e.target.closest('.teem-quick-btn');
      if (!btn) return;
      const itemName = btn.dataset.item;
      const orig = btn.textContent;
      btn.textContent = '...';
      btn.style.color = '#c9a227';

      const used = await attemptQuickUse(itemName);
      if (used) {
        btn.textContent = '✓ ' + itemName;
        btn.style.background = 'rgba(80,180,100,0.2)';
        btn.style.borderColor = 'rgba(80,180,100,0.4)';
        btn.style.color = '#50dc82';
      } else {
        btn.textContent = itemName + ' (not found)';
        btn.style.color = '#ff6060';
        setTimeout(() => {
          btn.textContent = orig;
          btn.style.color = '#e8dff5';
          btn.style.background = 'rgba(201,162,39,0.12)';
        }, 2500);
      }
    });
  }

  async function attemptQuickUse(itemName) {
    // Find item row by name text
    const nameEls = document.querySelectorAll('.name-wrap .name, .name.bold.t-overflow, [class*="name"]');
    let itemRow = null;
    for (const el of nameEls) {
      if (el.textContent.trim().toLowerCase() === itemName.toLowerCase()) {
        itemRow = el.closest('li, .item-info-wrap, [class*="item"]');
        break;
      }
    }
    if (!itemRow) return false;

    // Scroll to item and click it to open use menu
    itemRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise(r => setTimeout(r, 400));
    itemRow.click();
    await new Promise(r => setTimeout(r, 600));

    // Click Use button
    const useBtn = document.querySelector(
      'button.use-link, a.use-link, [data-action="use"], li.use a, .item-use-btn'
    );
    if (!useBtn) return false;
    useBtn.click();
    await new Promise(r => setTimeout(r, 400));

    // Click Confirm if present
    const confirmBtn = document.querySelector(
      'button.btn-confirm, a.btn-confirm, [data-action="confirm"], .confirm-use'
    );
    if (confirmBtn) confirmBtn.click();
    return true;
  }

  // Navigate to item market page and auto-click the cheapest listing
  async function injectBuyFlow(itemId, itemName, category) {
    if (!window.location.href.includes('imarket.php')) {
      const cat = category || '';
      window.location.href = itemId
        ? `https://www.torn.com/page.php?sid=ItemMarket#/market/view=category&categoryName=${encodeURIComponent(cat)}&itemID=${itemId}`
        : 'https://www.torn.com/page.php?sid=ItemMarket';
      return;
    }
    // Already on market page — find and click the item
    await waitForElement('.item-info-wrap, .item-market-wrap', 3000);
    const nameEls = document.querySelectorAll('.t-overflow, .bold.name, [class*="name"]');
    for (const el of nameEls) {
      if (el.textContent.trim().toLowerCase() === itemName.toLowerCase()) {
        el.closest('li, [class*="item"]')?.click();
        await new Promise(r => setTimeout(r, 600));
        // Click the first/cheapest buy button
        const buyBtn = document.querySelector('[class*="buy"], button[data-action="buy"], a.buy');
        if (buyBtn) {
          buyBtn.click();
          await new Promise(r => setTimeout(r, 400));
          const confirmBtn = document.querySelector('[class*="confirm"], button[data-action="confirm"]');
          if (confirmBtn) confirmBtn.click();
        }
        return;
      }
    }
  }

  // Navigate to bazaar/sell page and auto-fill item + price
  async function injectSellFlow(itemId, itemName, quantity, price) {
    // Store pending sell in sessionStorage so the injector can pick it up after navigation
    sessionStorage.setItem('teem_pending_sell', JSON.stringify({ itemId, itemName, quantity, price }));
    if (!window.location.href.includes('bazaar.php') && !window.location.href.includes('item.php')) {
      window.location.href = 'https://www.torn.com/item.php';
      return;
    }
    await executePendingSell();
  }

  async function executePendingSell() {
    const raw = sessionStorage.getItem('teem_pending_sell');
    if (!raw) return;
    let pending;
    try { pending = JSON.parse(raw); } catch(e) { return; }
    sessionStorage.removeItem('teem_pending_sell');

    const { itemId, itemName, quantity, price } = pending;

    // Wait for items to load
    await waitForElement('.name-wrap, [class*="item"]', 4000);
    await new Promise(r => setTimeout(r, 800));

    // Find item by name in inventory
    const nameEls = document.querySelectorAll('.name-wrap .name, .name.bold');
    for (const el of nameEls) {
      if (el.textContent.trim().toLowerCase() === itemName.toLowerCase()) {
        const row = el.closest('li, [class*="item"]');
        if (!row) continue;
        row.click();
        await new Promise(r => setTimeout(r, 600));

        // Look for "Sell" option in the action menu
        const sellBtn = document.querySelector(
          'a[data-action="sell"], button[data-action="sell"], li.sell a, [class*="sell-link"]'
        );
        if (sellBtn) {
          sellBtn.click();
          await new Promise(r => setTimeout(r, 500));

          // Fill in quantity
          const qtyInput = document.querySelector('input[name="qty"], input[class*="qty"], input[type="number"]');
          if (qtyInput) { qtyInput.value = quantity; qtyInput.dispatchEvent(new Event('input', { bubbles: true })); }

          // Fill in price
          const priceInput = document.querySelector('input[name="price"], input[class*="price"]');
          if (priceInput) { priceInput.value = price; priceInput.dispatchEvent(new Event('input', { bubbles: true })); }

          // Show confirmation overlay instead of auto-submitting — user confirms final price
          showSellConfirm(itemName, quantity, price);
        }
        return;
      }
    }
    showTeemNotice(`Could not find "${itemName}" in your inventory.`);
  }

  function showSellConfirm(name, qty, price) {
    const existing = document.getElementById('teem-sell-confirm');
    if (existing) existing.remove();
    const box = document.createElement('div');
    box.id = 'teem-sell-confirm';
    box.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);'
      + 'z-index:999999;background:rgba(13,5,32,0.98);border:1px solid rgba(201,162,39,0.4);'
      + 'border-radius:10px;padding:20px 24px;font-family:monospace;min-width:280px;'
      + 'box-shadow:0 8px 32px rgba(0,0,0,0.8);text-align:center;';
    box.innerHTML = `
      <div style="font-size:13px;color:#c9a227;font-weight:700;margin-bottom:8px;">⚡ TEEM Sell</div>
      <div style="font-size:11px;color:#d8c8f0;margin-bottom:4px;">${name}</div>
      <div style="font-size:11px;color:#8a7aaa;margin-bottom:12px;">${qty}x @ $${price.toLocaleString()}</div>
      <div style="font-size:10px;color:#4a3a6a;margin-bottom:14px;">Price fields have been auto-filled.<br>Click Confirm to submit the listing.</div>
      <div style="display:flex;gap:8px;justify-content:center;">
        <button id="teem-sell-ok" style="background:rgba(80,180,100,0.2);border:1px solid rgba(80,180,100,0.4);
          border-radius:5px;color:#50dc82;padding:6px 16px;cursor:pointer;font-family:monospace;font-size:11px;">
          ✓ Confirm
        </button>
        <button id="teem-sell-cancel" style="background:rgba(255,96,96,0.1);border:1px solid rgba(255,96,96,0.3);
          border-radius:5px;color:#ff6060;padding:6px 16px;cursor:pointer;font-family:monospace;font-size:11px;">
          ✕ Cancel
        </button>
      </div>
    `;
    document.body.appendChild(box);
    box.querySelector('#teem-sell-ok')?.addEventListener('click', () => {
      // Click Torn's own submit button
      const submitBtn = document.querySelector(
        'button[type="submit"], input[type="submit"], [class*="confirm-sell"], [class*="submit"]'
      );
      if (submitBtn) submitBtn.click();
      box.remove();
    });
    box.querySelector('#teem-sell-cancel')?.addEventListener('click', () => box.remove());
  }

  function showTeemNotice(msg) {
    const n = document.createElement('div');
    n.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);'
      + 'z-index:999999;background:rgba(13,5,32,0.95);border:1px solid rgba(201,162,39,0.3);'
      + 'border-radius:6px;padding:8px 16px;font-family:monospace;font-size:11px;color:#c9a227;';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3000);
  }

  function waitForElement(selector, timeoutMs = 3000) {
    return new Promise(resolve => {
      if (document.querySelector(selector)) return resolve(true);
      const observer = new MutationObserver(() => {
        if (document.querySelector(selector)) { observer.disconnect(); resolve(true); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(false); }, timeoutMs);
    });
  }

  function startInjector() {
    if (!settings.apiKey) return;

    // Initial runs — Torn's SPA often loads content after initial paint
    setTimeout(injectStatBadges, 1000);
    setTimeout(injectStatBadges, 3000);
    setTimeout(injectStatBadges, 6000);

    // Periodic sweep — catches anything the observer misses, and re-badges
    // links whose parent nodes were re-rendered by Torn's SPA
    setInterval(injectStatBadges, 8000);

    // Watch for DOM mutations — but only outside TEEM's own panel
    // so TEEM's internal re-renders don't constantly debounce the injector
    const observer = new MutationObserver((mutations) => {
      // Ignore mutations that only touch TEEM elements
      const teemOnly = mutations.every(m =>
        [...m.addedNodes].every(n =>
          n.nodeType !== 1 ||
          (n.id && (n.id.startsWith('tmit-') || n.id.startsWith('teem-'))) ||
          (n.closest && (n.closest('#tmit-panel') || n.closest('#teem-global-tip')))
        )
      );
      if (teemOnly) return;
      clearTimeout(observer._timer);
      observer._timer = setTimeout(injectStatBadges, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function safeInit() {
    try { init(); } catch(e) {
      // If init crashes, at minimum show the FAB so user knows TEEM is there
      const f = document.createElement('div');
      f.id = 'tmit-fab';
      f.style.cssText = 'position:fixed;bottom:28px;right:28px;width:52px;height:52px;border-radius:50%;background:#2d1b69;border:2px solid #c9a227;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;z-index:2147483646;';
      f.textContent = '🐘';
      f.title = 'TEEM error: ' + e.message;
      f.onclick = () => alert('TEEM init error: ' + e.message + '\n\nTry clearing TEEM storage in Tampermonkey dashboard.');
      document.body.appendChild(f);
    }
    try { setTimeout(injectQuickBar, 1500); } catch(e) {}
    try { setTimeout(executePendingSell, 1500); } catch(e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', safeInit);
  } else {
    safeInit();
  }


  } catch(e) {
    // Fatal error — show minimal FAB with error info
    function showError(msg) {
      if (document.body) {
        const f = document.createElement('div');
        f.style.cssText = 'position:fixed;bottom:28px;right:28px;width:52px;height:52px;border-radius:50%;background:#8b0000;border:2px solid #ff4040;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;z-index:2147483647;';
        f.textContent = '🐘';
        f.onclick = () => {
          alert('TEEM Error: ' + msg + '\n\nPlease report this to the developer.');
        };
        document.body.appendChild(f);
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => showError(e.message));
    } else {
      showError(e.message);
    }
  }

})();