// ==UserScript==
// @name         TEEM - Torn's Elephant Economy Manager
// @namespace    https://torn.com
// @version      6.0.0
// @description  TEEM — Torn's Elephant Economy Manager. Market tracker with hot/cold signals, travel profit rankings, war gear price tracker, and quick item use.
// @author       TornTravelTracker
// @match        https://www.torn.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      yata.life
// @connect      yata.yt
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
    marketPollSec: 120,         // how often to fetch item prices (seconds) — floored at 60 in startPolling
    statsPollSec:  30,          // how often to fetch bars/cooldowns (seconds)
    alertOnDrugClear: false,    // only alert when drug cooldown is clear
    alertOnBoosterClear: false, // only alert when booster cooldown is clear
    alertRequireStock: false,   // only alert when YATA confirms stock
    spikeAlertEnabled: true,    // pulse the FAB on 30%+ price spikes
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
    // Only thin when the array gets large — the tiered scheme caps at ~2069
    // snapshots per item, but most items have <60. Thinning on every append
    // costs O(snapshots) × per call which adds up to 50-100ms a poll.
    if (priceHistory[itemId].length > 300) {
      priceHistory[itemId] = thinHistory(priceHistory[itemId], now);
    }
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

  // Throttled + deferred history save. The priceHistory object grows to
  // several MB after a few hours of running, and JSON.stringify + storage
  // write on the main thread can block for 100-500ms per poll. Instead:
  //   - throttle to every 5 polls (~5 min)
  //   - defer via requestIdleCallback so the write runs during idle time
  //   - flush on beforeunload as a safety net (see init)
  let _pollsSinceSave = 0;
  let _saveScheduled  = false;
  function saveHistory() {
    if (++_pollsSinceSave < 5) return;
    if (_saveScheduled) return;
    _saveScheduled = true;
    const doSave = () => {
      _saveScheduled = false;
      _pollsSinceSave = 0;
      try { store('priceHistory', priceHistory); } catch(e) {}
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(doSave, { timeout: 10000 });
    } else {
      setTimeout(doSave, 100);
    }
  }
  function saveHistoryNow() {
    // Synchronous flush — only call on beforeunload
    _saveScheduled = false; _pollsSinceSave = 0;
    try { store('priceHistory', priceHistory); } catch(e) {}
  }

  let itemMeta = load('itemMeta', {}); // { id: { name, type, image } }

  let lastYataPrices = {};
  let analysisCache  = [];
  let lastRenderedIds = [];  // item IDs currently shown in the panel — fed into the live-fetch priority list
  let watchlist      = new Set(load('watchlist', []));
  let myBattleStats    = load('myBattleStats', null);
  let statHistory      = load('statHistory', []);         // [ { ts, str, def, spd, dex, ts_total } ]
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
  let userInventory   = {};  // { itemId: { name, quantity, uid } } — refreshed each poll
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
    signal:     'Buy-low-sell-high signal for flippers.\nSELL = price up 5%+ (cash out into strength). BUY = price down 8%+ (buy the dip). HOLD = mild rise (wait for more upside). WATCH = volatile, no clear direction.',
    confidence: 'Confidence dots show how strong the signal is.\n● ● ● = strong trend, lots of data.\n● ● ○ = moderate.\n● ○ ○ = early/thin data.',
    pph:        'Profit Per Hour — estimated $ earned per hour of round-trip travel, after 5% sales tax.',
    stock:      'YATA ✓ = live crowd-sourced stock data from yata.life.\n~stock = no data, assuming full stock (optimistic).',
    change:     'Price change % over your selected timeframe.\nOrange = price rising (hot). Teal = falling (cold).',
    dataAge:    'How long ago prices were last fetched. Green = fresh. Yellow = >5min old. Red = >15min.',
  };
  // ── Brand mark ─────────────────────────────────────────────────────────────
  // Custom logo: an anthropomorphic elephant with a magenta flame mohawk,
  // lavender body, big confident eyes, smirk, and trunk curled around a
  // gold coin (the literal "Elephant Economy Manager" thesis). Replaces
  // the OS-rendered 🐘 emoji so the brand looks the same on every device.
  // Used in the FAB, the panel title, and onboarding.
  // Esports-mascot style: front-facing elephant on a purple-outlined shield.
  // Magenta flame mohawk (TEEM signature) + iconic pixel "deal-with-it"
  // sunglasses (cool factor, reads at small sizes) + trunk hanging from the
  // face center with a gold coin in its curl (the brand thesis: elephant
  // managing the economy). Gritty gray palette and bold black outlines
  // match the badass esports-mascot aesthetic.
  // Original TEEM logo (purple-caparisoned elephant + cyan wordmark)
  // embedded as a base64 PNG so the script stays fully self-contained.
  // At FAB scale the baked-in wordmark is only ~3px tall — unreadable —
  // so the FAB renders the elephant from this PNG and overlays "TEEM"
  // as CSS text below it (see .tmit-fab-brand in the stylesheet).
  const TEEM_ELEPHANT_DATAURL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAMAAACahl6sAAAAAXNSR0IB2cksfwAAAAlwSFlzAAAewgAAHsIBbtB1PgAAAu5QTFRFAAAAJB4yKSM4Ny5EMSo6JBsxUERbTUBWVEdeQDdKHxkjIBoqKSMwRDtO70gRSD1TEg8WWUlllAC7VQC8iACuPTVFHxcpYgDCKSA3cwDIngDGDtzsOTQ9GBQbX09reQGksADlpQDi4k8dgQKcsQDVAAAAWAF1ugDqDAoOZgGDbgCXdQGOmADdwQLanwDNd5eHhot2AAAAggDRAAAAWFBgqQDFHdbhjADXXwCPXUh7PDRLAAAAIgstBgYHa0iwAAAAtgPMloNoaaKVZUqcTkZUZVpuAQEBKiYrCzo9Mi4yAAAAMiU9AAAAnAOxNw1AS7a1yV40o3VXIRweAQEBQgRWbF13xwDuKCo5O8DCOy9LSQJjAAAAL8rPWKylLB0zKNLbtG1JSEFWMgRB11Qlamdo+2k73QbtzAHgEykqSDJbWSMPAAAAIyIl2anfTUVNPj0/AwMDPyN4y4nfWVVWRQGjPh1Sx00j05bhAllgoqGgWQCiqFjIHgGgNBoQXAZse3h9UQCyjQSlT4B5Pz1BaT62SgGGoo97v2Y/KhM+OQF0VDKJa2lskpeVuXbSIQG+01osCAgIacPEz9bWusK9PishLy8vaTmZHFJVtpZ9sbKwT05PysjGg9/jderz43VQSwG2c3JyYBWGNQZORhJintrbx7eon8vH65p+d0qQrq2uiIqKZE1BWNfdh4eHaGdpaWhpqQW9MgGNi1TAPEJLUVBRwMDBLy8vvDsSHwF+amdsdh+LjSKmKRMMl66tlDcW8vHwubm5NVZW5GU7Nha+Dg4OFMPPIyIjmJiYGgBkRSttPmZo49rWFXN4oaChXCBtz6WRzIVo6urqRuXxn1i2nxSy9IdkVTsvGxsb9a+YUlBSfX19SiKvoaGhUlJSaQWuubm5OJWWlUq1dDcffX19ODg5i4mKEZym3bShqx6/7u7u687DcRrHyeXmWx2onDq4Ghoa1tbWinSliGGOXVallpeWV1haTUtTWVdcIiIiTEVRgoumBQAAAPp0Uk5TAP///////////////////////////////////////////////w///////////////63/IP////////88//7/Wv///////8H///+O/87///////+d/////////3H///////////7//////f+B/v/75OP///n//v////v///////////+8/////////7D8////t//8///n/////cP//////1r//////////x34//9HQ4n/////WQu+///e/v/////4NP///9n/2C/////8/0r9///A///////E/6kt/9OO/+H////hTl////+U///+//9WSv///xebl+Z98WyJcRIAAEE4SURBVHic7b17YBvlmeid0Yxuo5nVeDKjyDozHrsSii6W2gRprahy6hY5ilDkbo1I1u6uu3Z9bEJFQohd6uA4EYlb2wk5kBs1CU1iciNAcJrABlJuhQKBEmhJgUDXLZe2HOi2p7TA8t/3PO9ItpOa/UpsyvnjPE5sSyO9en/z3N+5eNas/yf/TybJPQ988NamTZvuvWfTffoT8OPO287tvefe91/9bGf2SWTvWxuadgZDHXWhTu8dG8jEP1y14XDyTLau8Pqfu8/d+VlP8G+Te/7U++5oKBSt6wyFOjpCHe4NJzbd5q/rLLzWO+YOneo6GWz6zWc9x79FfrNvy5ygS8y+/p9aITu6Blj+sHmwEBztdGtrpFBHyO8Pdtxx4v9+pdxzxh0MZqNvLxzu7c3WaVJnXce+3t41odG6aFDTPJ3ZaEDscOc++qzn+f8nr56tK3R2dGTfPtbb2+sq+F2dZ0NSf78WqutEU/Nk60bfDp364b7uez7rmf73sqm749SDnaFoIQuzl/yS5ol66lyeUGf27NnREDh/yBMKewpdXe4z/1cb16OrvIVQdLQzKkma1+uVpE6tv67gCbnrotFoNlSXjY6GTj0+W/THAsFz933Ws/14eeBBf0enJ/BndyEqxbSA5g6GQBsQhd037RGz7p1dmihGsycHxZAnEF117rOe7sdLU7+nMxp9bYvb7dK6olpUzGaj2ey7b4f8XVukzsu2Pr4lIHmioiSe0ja+dsfpz3q6F8pzezGD3znrvrf+I3r2rKvQvybkF6OdHjGq/WmPGHXf8Han6A+461bt2rKl1+3OusIejyb2Bh/4rCd+njx123F5RdKywpqWV9b1uR5/1+32Br3iH94dja7R/nxTb1fW3dEJIavDPdrfCyABd0GE1OLyitE79n7Wk5+QezYokfb6SHKFJVJfn+zuE0/2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";

  let alertActive = false, pollingTimer = null, statsTimer = null, uiBuilt = false;
  let sessionTimer = null, footerTimer = null;
  let backgroundSuspended = true;  // start suspended — only run when panel is open
  let pollCounter = 0;  // increments each poll; drives adaptive cadence in buildPriorityList

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

  // Look up the user's inventory quantity for a given item name.
  // Used by the Quick Use bar/tab to show stock counts and disable
  // pinned items the user has zero of.
  function getInventoryQty(itemName) {
    if (!itemName) return 0;
    const lower = itemName.toLowerCase();
    for (const id in userInventory) {
      if ((userInventory[id].name || '').toLowerCase() === lower) {
        return userInventory[id].quantity || 0;
      }
    }
    return 0;
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
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700&family=Inter:wght@400;500;600&display=swap');
    #tmit-fab{position:fixed;bottom:28px;right:28px;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#320042,#09000d);border:2px solid #c9a227;box-shadow:0 0 14px rgba(151,2,173,0.5),0 4px 24px rgba(0,0,0,0.8);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:22px;z-index:999999;transition:all 0.3s ease;user-select:none;}
    #tmit-fab:hover{transform:scale(1.1);box-shadow:0 0 26px rgba(151,2,173,0.8),0 4px 28px rgba(0,0,0,0.9);}
    /* Big-hit indicator: a static coin badge with the elephant on it.
       No animation, no transitions — just appears when a huge spike is
       detected. Toggling the .tmit-alert class is a single display swap,
       no per-frame work. Background color reflects the item-type of the
       biggest spike (set via .type-* class on the badge). */
    #tmit-fab .tmit-alert-badge{display:none;position:absolute;top:-5px;right:-5px;width:24px;height:24px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffe680 0%,#c9a227 55%,#7a5d10 100%);border:2px solid #09000d;box-shadow:0 0 8px rgba(255,224,102,0.7),inset 0 1px 1px rgba(255,255,255,0.4);align-items:center;justify-content:center;font-size:13px;line-height:1;pointer-events:none;color:#000;font-weight:900;font-family:'Inter',sans-serif;}
    #tmit-fab.tmit-alert .tmit-alert-badge{display:flex;}
    /* Badge type colors — keyed to common Torn item categories. */
    .tmit-alert-badge.type-drug{background:radial-gradient(circle at 35% 35%,#d680f0 0%,#9702ad 55%,#5a106a 100%);box-shadow:0 0 8px rgba(151,2,173,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-medical{background:radial-gradient(circle at 35% 35%,#ff9090 0%,#ff4040 55%,#8b0000 100%);box-shadow:0 0 8px rgba(255,64,64,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-plushie{background:radial-gradient(circle at 35% 35%,#ffb0d0 0%,#ff70a0 55%,#a04068 100%);box-shadow:0 0 8px rgba(255,112,160,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-flower{background:radial-gradient(circle at 35% 35%,#a0f0b0 0%,#50dc82 55%,#1f6a40 100%);box-shadow:0 0 8px rgba(80,220,130,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-booster{background:radial-gradient(circle at 35% 35%,#fff8a0 0%,#ffe066 55%,#a08010 100%);box-shadow:0 0 8px rgba(255,224,102,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-alcohol{background:radial-gradient(circle at 35% 35%,#ffd080 0%,#e89020 55%,#7a4810 100%);box-shadow:0 0 8px rgba(232,144,32,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-energy{background:radial-gradient(circle at 35% 35%,#a0f0ff 0%,#00e5ff 55%,#005566 100%);box-shadow:0 0 8px rgba(0,229,255,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-weapon{background:radial-gradient(circle at 35% 35%,#ffc080 0%,#ff6a00 55%,#7a2500 100%);box-shadow:0 0 8px rgba(255,106,0,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-armor{background:radial-gradient(circle at 35% 35%,#b0c8ff 0%,#5078d0 55%,#1a2a60 100%);box-shadow:0 0 8px rgba(80,120,208,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    .tmit-alert-badge.type-special{background:radial-gradient(circle at 35% 35%,#ffffff 0%,#e0e0ff 55%,#7080a0 100%);box-shadow:0 0 8px rgba(200,200,255,0.7),inset 0 1px 1px rgba(255,255,255,0.4);}
    #tmit-panel{position:fixed;bottom:90px;right:28px;width:520px;max-height:620px;background:linear-gradient(180deg,rgba(50,0,66,0.97) 0%,rgba(18,0,28,0.99) 40%,rgba(7,0,10,1) 100%);border:1px solid #9702ad;border-top:3px solid #c9a227;border-radius:12px;box-shadow:0 0 0 1px rgba(0,0,0,0.8),0 0 50px rgba(151,2,173,0.12),0 24px 80px rgba(0,0,0,0.9),inset 0 1px 0 rgba(201,162,39,0.15);z-index:999998;display:flex;flex-direction:column;overflow:hidden;font-family:'Inter',sans-serif;color:#f0d5f8;transition:opacity 0.2s,transform 0.2s;}
    #tmit-panel.tmit-hidden{display:none !important;}
    .tmit-header{background:linear-gradient(90deg,rgba(50,0,66,1) 0%,rgba(18,0,28,1) 60%,rgba(8,0,14,1) 100%);border-bottom:1px solid rgba(151,2,173,0.35);padding:11px 16px;display:flex;align-items:center;justify-content:space-between;cursor:move;flex-shrink:0;position:relative;}
    .tmit-header::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent 0%,#c9a227 30%,#ffe066 50%,#c9a227 70%,transparent 100%);opacity:0.7;}
    .tmit-title{font-family:'Cinzel',serif;font-size:14px;font-weight:700;color:#c9a227;letter-spacing:0.06em;display:flex;align-items:center;gap:8px;text-shadow:0 0 12px rgba(201,162,39,0.4);}
    .tmit-title-icon{font-size:16px;}
    .tmit-header-right{display:flex;align-items:center;gap:8px;}
    .tmit-status-pill{font-size:10px;padding:2px 8px;border-radius:20px;background:rgba(151,2,173,0.08);border:1px solid rgba(151,2,173,0.25);color:#c9a227;font-family:monospace;}
    .tmit-status-pill.tmit-ok{border-color:rgba(80,220,130,0.4);color:#50dc82;background:rgba(80,220,130,0.07);}
    .tmit-status-pill.tmit-live{border-color:rgba(255,200,50,0.5);color:#ffe066;background:rgba(255,200,50,0.07);}
    .tmit-status-pill.tmit-err{border-color:rgba(255,80,80,0.4);color:#ff6060;background:rgba(255,80,80,0.07);}
    .tmit-btn-close,.tmit-btn-settings-toggle,.tmit-btn-refresh{background:rgba(0,0,0,0.3);border:1px solid rgba(151,2,173,0.25);color:#7a2090;border-radius:4px;width:24px;height:24px;cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all 0.15s;padding:0;line-height:1;}
    .tmit-btn-close:hover,.tmit-btn-settings-toggle:hover,.tmit-btn-refresh:hover{border-color:#9702ad;color:#e040f0;background:rgba(151,2,173,0.12);box-shadow:0 0 8px rgba(151,2,173,0.3);}
    .tmit-tab-bar{display:flex;border-bottom:1px solid rgba(151,2,173,0.2);flex-shrink:0;background:rgba(0,0,0,0.4);}
    .tmit-tab{flex:1;padding:7px 0;font-size:11px;font-weight:600;text-align:center;cursor:pointer;color:#b481cc;border-bottom:2px solid transparent;transition:all 0.15s;letter-spacing:0.04em;user-select:none;}
    .tmit-tab:hover{color:#c9a227;}
    .tmit-tab.tmit-tab-active{color:#ffe066;border-bottom-color:#c9a227;background:rgba(201,162,39,0.04);}
    .tmit-tab .tmit-tab-count{display:inline-block;margin-left:4px;font-size:9px;background:rgba(151,2,173,0.15);color:#9702ad;border-radius:8px;padding:0 5px;font-family:monospace;vertical-align:middle;}
    .tmit-tab.tmit-tab-active .tmit-tab-count{background:rgba(201,162,39,0.3);}
    .tmit-controls{padding:7px 12px;border-bottom:1px solid rgba(151,2,173,0.1);display:flex;gap:6px;align-items:center;flex-wrap:wrap;flex-shrink:0;background:rgba(0,0,0,0.35);}
    .tmit-timeframe-group,.tmit-filter-group{display:flex;gap:3px;}
    .tmit-tf-btn{background:rgba(0,0,0,0.4);border:1px solid rgba(151,2,173,0.15);color:#b481cc;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer;transition:all 0.15s;font-family:monospace;}
    .tmit-tf-btn:hover{border-color:#9702ad;color:#cc40f0;}
    .tmit-tf-btn.tmit-active{background:rgba(151,2,173,0.15);border-color:#9702ad;color:#e040f0;box-shadow:0 0 6px rgba(151,2,173,0.25);}
    .tmit-divider{width:1px;height:20px;background:rgba(151,2,173,0.15);margin:0 2px;}
    .tmit-select{background:rgba(0,0,0,0.4);border:1px solid rgba(151,2,173,0.18);color:#c9a227;border-radius:4px;padding:3px 6px;font-size:11px;cursor:pointer;outline:none;font-family:'Inter',sans-serif;}
    .tmit-select option{background:#120010;color:#f0d5f8;}
    .tmit-search{flex:1;min-width:80px;background:rgba(0,0,0,0.4);border:1px solid rgba(151,2,173,0.18);border-radius:4px;color:#f0d5f8;font-size:11px;padding:3px 8px;outline:none;font-family:'Inter',sans-serif;}
    .tmit-search::placeholder{color:#9b7bb5;opacity:1;}
    #tmit-panel input::placeholder,#tmit-onboard input::placeholder{color:#9b7bb5;opacity:1;}
    .tmit-search:focus{border-color:rgba(151,2,173,0.5);}
    .tmit-filter-row{padding:5px 12px;border-bottom:1px solid rgba(151,2,173,0.08);display:flex;gap:8px;align-items:center;flex-shrink:0;background:rgba(0,0,0,0.3);}
    .tmit-filter-label{font-size:10px;color:#b481cc;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;white-space:nowrap;}
    .tmit-input-sm{background:rgba(0,0,0,0.4);border:1px solid rgba(151,2,173,0.18);border-radius:4px;color:#f0d5f8;font-size:11px;padding:3px 8px;width:100px;outline:none;font-family:monospace;}
    .tmit-input-sm:focus{border-color:rgba(151,2,173,0.5);}
    .tmit-col-headers{display:grid;grid-template-columns:1fr 90px 90px 80px 60px;padding:5px 12px;border-bottom:1px solid rgba(151,2,173,0.12);flex-shrink:0;background:rgba(0,0,0,0.5);}
    .tmit-col-hdr{font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#b481cc;cursor:pointer;user-select:none;transition:color 0.15s;}
    .tmit-col-hdr:hover{color:#c9a227;}
    .tmit-col-hdr.tmit-sorted{color:#c9a227;}
    .tmit-col-hdr:not(:first-child){text-align:right;}
    .tmit-list{overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:rgba(151,2,173,0.25) transparent;}
    .tmit-list::-webkit-scrollbar{width:4px;}
    .tmit-list::-webkit-scrollbar-track{background:transparent;}
    .tmit-list::-webkit-scrollbar-thumb{background:rgba(151,2,173,0.25);border-radius:2px;}
    .tmit-tab-panel{scrollbar-width:thin;scrollbar-color:rgba(151,2,173,0.5) rgba(255,255,255,0.04);}
    .tmit-tab-panel::-webkit-scrollbar{width:5px;}
    .tmit-tab-panel::-webkit-scrollbar-track{background:rgba(255,255,255,0.04);border-radius:3px;}
    .tmit-tab-panel::-webkit-scrollbar-thumb{background:rgba(151,2,173,0.5);border-radius:3px;}
    .tmit-tab-panel::-webkit-scrollbar-thumb:hover{background:rgba(151,2,173,0.8);}
    .tmit-settings-panel{scrollbar-width:thin;scrollbar-color:rgba(151,2,173,0.5) rgba(255,255,255,0.04);}
    .tmit-settings-panel::-webkit-scrollbar{width:5px;}
    .tmit-settings-panel::-webkit-scrollbar-track{background:rgba(255,255,255,0.04);border-radius:3px;}
    .tmit-settings-panel::-webkit-scrollbar-thumb{background:rgba(151,2,173,0.5);border-radius:3px;}
    .tmit-settings-panel::-webkit-scrollbar-thumb:hover{background:rgba(151,2,173,0.8);}
    .tmit-item-row{display:grid;grid-template-columns:1fr 90px 90px 80px 60px;padding:7px 12px;border-bottom:1px solid rgba(255,255,255,0.03);align-items:center;transition:background 0.12s;cursor:default;position:relative;}
    .tmit-item-row:hover{background:rgba(151,2,173,0.05);}
    .tmit-item-row.tmit-hot{background:linear-gradient(90deg,rgba(232,98,26,0.08) 0%,transparent 100%);border-left:2px solid #e8621a;}
    .tmit-item-row.tmit-hot::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#ffe066,#e8621a,#8b2500);box-shadow:0 0 6px rgba(232,98,26,0.6);}
    .tmit-item-row.tmit-hot:hover{background:linear-gradient(90deg,rgba(232,98,26,0.13) 0%,transparent 100%);}
    .tmit-item-row.tmit-hot-big{background:linear-gradient(90deg,rgba(232,98,26,0.16) 0%,transparent 70%);border-left:2px solid #ff6a00;}
    .tmit-item-row.tmit-hot-big::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#fff0a0,#ff6a00,#8b2500);box-shadow:0 0 10px rgba(255,106,0,0.8);}
    @keyframes tmit-ember{from{background:linear-gradient(90deg,rgba(232,98,26,0.10) 0%,transparent 70%);}to{background:linear-gradient(90deg,rgba(232,98,26,0.20) 0%,transparent 70%);}}
    .tmit-item-row.tmit-icy{background:linear-gradient(90deg,rgba(61,214,200,0.07) 0%,transparent 100%);border-left:2px solid #3dd6c8;}
    .tmit-item-row.tmit-icy::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#e0ffff,#3dd6c8,#0a5a54);box-shadow:0 0 6px rgba(61,214,200,0.5);}
    .tmit-item-row.tmit-icy:hover{background:linear-gradient(90deg,rgba(61,214,200,0.11) 0%,transparent 100%);}
    .tmit-item-row.tmit-icy-big{background:linear-gradient(90deg,rgba(61,214,200,0.14) 0%,transparent 70%);border-left:2px solid #00e5ff;}
    .tmit-item-row.tmit-icy-big::after{content:'';position:absolute;left:0;top:0;bottom:0;width:2px;background:linear-gradient(180deg,#ffffff,#00e5ff,#005566);box-shadow:0 0 10px rgba(0,229,255,0.7);}
    @keyframes tmit-frost{from{background:linear-gradient(90deg,rgba(61,214,200,0.08) 0%,transparent 70%);}to{background:linear-gradient(90deg,rgba(61,214,200,0.16) 0%,transparent 70%);}}
    .tmit-item-row.tmit-pinned{border-left:2px solid #c9a227;background:rgba(201,162,39,0.04);}
    .tmit-item-name{font-size:12px;font-weight:500;color:#e8caf5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:8px;}
    .tmit-item-name .tmit-spike-icon{font-size:10px;margin-right:4px;}
    .tmit-item-type{font-size:9px;color:#9b7bb5;margin-top:1px;}
    .tmit-price{font-family:monospace;font-size:11px;color:#a840c0;text-align:right;}
    .tmit-change{font-family:monospace;font-size:12px;font-weight:700;text-align:right;}
    .tmit-change.up{color:#e8621a;text-shadow:0 0 8px rgba(232,98,26,0.5);}
    .tmit-change.down{color:#3dd6c8;text-shadow:0 0 8px rgba(61,214,200,0.4);}
    .tmit-change.flat{color:#9b7bb5;}
    .tmit-signal{text-align:right;}
    .tmit-signal-badge{display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.06em;padding:2px 6px;border-radius:3px;text-transform:uppercase;}
    .tmit-signal-badge.BUY{background:rgba(61,214,200,0.15);color:#3dd6c8;border:1px solid rgba(61,214,200,0.35);text-shadow:0 0 6px rgba(61,214,200,0.3);}
    .tmit-signal-badge.SELL{background:rgba(232,98,26,0.18);color:#ff8c42;border:1px solid rgba(232,98,26,0.4);text-shadow:0 0 6px rgba(232,98,26,0.4);}
    .tmit-signal-badge.HOLD{background:rgba(201,162,39,0.15);color:#c9a227;border:1px solid rgba(201,162,39,0.3);}
    .tmit-signal-badge.WATCH{background:rgba(151,2,173,0.12);color:#cc40f0;border:1px solid rgba(151,2,173,0.28);cursor:pointer;transition:all 0.2s;}
    .tmit-signal-badge.WATCH:hover{background:rgba(201,162,39,0.18);color:#ffe066;border-color:rgba(201,162,39,0.5);}
    .tmit-signal-badge.WATCH.tmit-watched{background:rgba(201,162,39,0.22);color:#ffe066;border-color:#c9a227;box-shadow:0 0 7px rgba(201,162,39,0.45);}
    .tmit-confidence-bar{display:flex;gap:2px;align-items:center;}
    .tmit-conf-dot{width:5px;height:5px;border-radius:50%;background:rgba(151,2,173,0.12);}
    .tmit-conf-dot.filled{background:#9702ad;box-shadow:0 0 3px rgba(151,2,173,0.5);}
    .tmit-row-btn{background:none;border:none;cursor:pointer;font-size:13px;padding:2px;opacity:0.45;transition:opacity 0.15s;line-height:1;}
    .tmit-row-btn:hover{opacity:1;}
    .tmit-state-msg{padding:32px 20px;text-align:center;color:#9b7bb5;font-size:13px;line-height:1.7;}
    .tmit-state-msg .tmit-state-icon{font-size:28px;margin-bottom:8px;}
    .tmit-settings-panel{padding:14px 16px;border-top:1px solid rgba(151,2,173,0.18);background:rgba(0,0,0,0.5);display:none;flex-shrink:0;overflow-y:auto;max-height:320px;}
    .tmit-settings-panel.tmit-open{display:block;}
    .tmit-settings-title{font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:10px;}
    .tmit-setting-row{display:flex;align-items:center;gap:10px;margin-bottom:8px;}
    .tmit-setting-row label{font-size:11px;color:#7a2090;width:100px;flex-shrink:0;}
    .tmit-setting-row input{flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(151,2,173,0.22);border-radius:4px;color:#f0d5f8;font-size:12px;padding:5px 9px;outline:none;font-family:monospace;}
    .tmit-setting-row input:focus{border-color:rgba(151,2,173,0.55);}
    .tmit-btn-save{margin-top:8px;background:linear-gradient(90deg,#c9a227 0%,#8b6e10 50%,#c9a227 100%);background-size:200%;border:none;border-radius:5px;color:#09000d;font-weight:700;font-size:12px;padding:6px 18px;cursor:pointer;font-family:'Inter',sans-serif;transition:background-position 0.4s,filter 0.15s;}
    .tmit-btn-save:hover{background-position:right;filter:brightness(1.15);}
    .tmit-footer{padding:5px 12px;border-top:1px solid rgba(151,2,173,0.1);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;background:rgba(0,0,0,0.6);}
    .tmit-footer-stat{font-size:9px;color:#9b7bb5;font-family:monospace;}
    .tmit-footer-stat span{color:#b481cc;}
    .tmit-section-title{font-family:'Cinzel',serif;font-size:11px;font-weight:700;color:#c9a227;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid rgba(201,162,39,0.2);}
    .tmit-war-form{margin-bottom:10px;}
    .tmit-form-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
    .tmit-form-row label{font-size:10px;color:#b481cc;font-weight:600;width:120px;flex-shrink:0;text-transform:uppercase;letter-spacing:0.05em;}
    .tmit-form-row2{display:flex;gap:8px;margin-bottom:6px;}
    .tmit-form-row2 > div{flex:1;display:flex;flex-direction:column;gap:3px;}
    .tmit-form-row2 label{font-size:9px;color:#b481cc;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;}
    .tmit-input-full{width:100%;background:rgba(0,0,0,0.4);border:1px solid rgba(151,2,173,0.18);border-radius:4px;color:#f0d5f8;font-size:11px;padding:4px 8px;outline:none;font-family:monospace;}
    .tmit-input-full:focus{border-color:rgba(151,2,173,0.5);}
    .tmit-btn-calc{margin-top:6px;background:linear-gradient(90deg,#c9a227,#8b6e10);border:none;border-radius:5px;color:#09000d;font-weight:700;font-size:11px;padding:5px 16px;cursor:pointer;font-family:'Inter',sans-serif;transition:filter 0.15s;}
    .tmit-btn-calc:hover{filter:brightness(1.2);}
    .tmit-calc-result{background:rgba(0,0,0,0.35);border:1px solid rgba(151,2,173,0.2);border-radius:6px;padding:10px 12px;margin-top:8px;font-size:11px;line-height:1.8;}
    .tmit-calc-result .tmit-result-row{display:flex;justify-content:space-between;align-items:center;padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.04);}
    .tmit-calc-result .tmit-result-row:last-child{border-bottom:none;}
    .tmit-result-label{color:#7a2090;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;}
    .tmit-result-val{color:#f0d5f8;font-family:monospace;font-weight:600;}
    .tmit-result-val.gold{color:#ffe066;}
    .tmit-result-val.hot{color:#e8621a;}
    .tmit-result-val.icy{color:#3dd6c8;}
    .tmit-result-val.green{color:#50dc82;}
    .tmit-war-tracker{margin-top:4px;}
    .tmit-war-row{display:grid;grid-template-columns:1fr 80px 80px 70px 55px;padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;font-size:11px;border-radius:3px;margin-bottom:1px;}
    .tmit-war-row:hover{background:rgba(151,2,173,0.05);}
    .tmit-war-row.yellow-item{border-left:2px solid #ffe066;}
    .tmit-war-row.orange-item{border-left:2px solid #e8621a;}
    .tmit-war-row.red-item{border-left:2px solid #ff4040;}
    .tmit-war-name{color:#e8caf5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .tmit-war-price{color:#a840c0;font-family:monospace;font-size:10px;text-align:right;}
    .tmit-war-bb{color:#ffe066;font-family:monospace;font-size:10px;text-align:right;}
    .tmit-war-chg{font-family:monospace;font-size:10px;font-weight:700;text-align:right;}
    .tmit-travel-row{display:grid;grid-template-columns:24px 1fr 90px 80px 70px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;cursor:pointer;border-radius:3px;transition:background 0.12s;}
    .tmit-travel-row:hover{background:rgba(151,2,173,0.06);}
    .tmit-travel-row.rank1{border-left:2px solid #ffe066;background:rgba(201,162,39,0.05);}
    .tmit-travel-row.rank2{border-left:2px solid #c0c0c0;}
    .tmit-travel-row.rank3{border-left:2px solid #cd7f32;}
    .tmit-travel-flag{font-size:14px;}
    .tmit-travel-dest{font-size:12px;font-weight:500;color:#e8caf5;}
    .tmit-travel-sub{font-size:9px;color:#b481cc;margin-top:1px;}
    .tmit-travel-pph{font-family:monospace;font-size:12px;font-weight:700;color:#e8621a;text-align:right;}
    .tmit-travel-pph.top{color:#ffe066;text-shadow:0 0 8px rgba(255,224,102,0.4);}
    .tmit-travel-time{font-family:monospace;font-size:10px;color:#b481cc;text-align:right;}
    .tmit-travel-stock{font-size:9px;text-align:right;font-family:monospace;}
    .tmit-travel-stock.yata{color:#50dc82;}
    .tmit-travel-stock.assumed{color:#b481cc;}
    .tmit-travel-detail-card{background:rgba(0,0,0,0.3);border:1px solid rgba(151,2,173,0.18);border-radius:6px;padding:10px 12px;}
    .tmit-session-bar{padding:4px 12px;background:rgba(0,0,0,0.4);border-bottom:1px solid rgba(151,2,173,0.1);display:flex;gap:12px;align-items:center;font-size:10px;font-family:monospace;flex-shrink:0;}
    .tmit-session-item{display:flex;align-items:center;gap:4px;color:#b481cc;}
    .tmit-session-val{color:#a840c0;font-weight:600;}
    .tmit-session-val.positive{color:#50dc82;}
    .tmit-session-val.hot{color:#e8621a;}
    .tmit-age-dot{width:6px;height:6px;border-radius:50%;display:inline-block;margin-right:3px;}
    .tmit-age-fresh{background:#50dc82;}
    .tmit-age-stale{background:#c9a227;}
    .tmit-age-old{background:#ff6060;}
    .tmit-btn-export{background:none;border:1px solid rgba(151,2,173,0.2);color:#b481cc;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer;transition:all 0.15s;font-family:'Inter',sans-serif;font-weight:600;}
    .tmit-btn-export:hover{border-color:#9702ad;color:#cc40f0;}
    .tmit-btn-retry{display:inline-block;margin-top:8px;background:rgba(151,2,173,0.15);border:1px solid rgba(151,2,173,0.3);border-radius:5px;color:#9702ad;font-size:11px;font-weight:600;padding:5px 14px;cursor:pointer;font-family:'Inter',sans-serif;}
    .tmit-btn-retry:hover{background:rgba(151,2,173,0.25);}
    .tmit-skeleton{background:linear-gradient(90deg,rgba(255,255,255,0.03) 0%,rgba(255,255,255,0.07) 50%,rgba(255,255,255,0.03) 100%);background-size:200% 100%;animation:tmit-shimmer 1.4s infinite;border-radius:3px;height:10px;margin:4px 0;}
    @keyframes tmit-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}
    .tmit-help{display:inline-flex;align-items:center;justify-content:center;width:13px;height:13px;border-radius:50%;background:rgba(151,2,173,0.12);border:1px solid rgba(151,2,173,0.25);color:#9702ad;font-size:8px;font-weight:700;cursor:help;margin-left:4px;position:relative;vertical-align:middle;flex-shrink:0;}
    .tmit-help::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);right:0;left:auto;transform:none;background:#1a0020;border:1px solid rgba(151,2,173,0.3);border-radius:6px;padding:8px 11px;font-size:10px;color:#e8c8f5;white-space:pre-line;width:220px;line-height:1.6;z-index:999999;opacity:0;pointer-events:none;transition:opacity 0.15s;box-shadow:0 6px 24px rgba(0,0,0,0.7);font-family:'Inter',sans-serif;font-weight:400;letter-spacing:0;text-transform:none;}
    .tmit-help:hover::after{opacity:1;}
    #tmit-onboard{position:fixed;bottom:28px;left:28px;z-index:9999999;animation:tmit-slidein 0.4s cubic-bezier(0.16,1,0.3,1);}
    @keyframes tmit-slidein{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}
    .tmit-onboard-card{background:linear-gradient(160deg,#1a0020 0%,#09000d 100%);border:1px solid #9702ad;border-top:3px solid #c9a227;border-radius:12px;width:340px;padding:18px 18px 14px;box-shadow:0 0 40px rgba(151,2,173,0.18),0 16px 48px rgba(0,0,0,0.8);position:relative;}
    .tmit-onboard-logo{width:56px;height:56px;border-radius:50%;border:2px solid #c9a227;margin:0 auto 14px;display:block;}
    .tmit-onboard-title{font-family:'Cinzel',serif;font-size:18px;font-weight:700;color:#c9a227;text-align:center;margin-bottom:4px;letter-spacing:0.05em;}
    .tmit-onboard-subtitle{font-size:11px;color:#b481cc;text-align:center;margin-bottom:20px;}
    .tmit-onboard-step{display:none;}
    .tmit-onboard-step.active{display:block;}
    .tmit-onboard-step-title{font-size:13px;font-weight:700;color:#f0d5f8;margin-bottom:8px;}
    .tmit-onboard-step-body{font-size:12px;color:#7a2090;line-height:1.7;margin-bottom:16px;}
    .tmit-onboard-step-body b{color:#c9a227;}
    .tmit-onboard-step-body code{background:rgba(0,0,0,0.4);border:1px solid rgba(151,2,173,0.2);border-radius:3px;padding:1px 5px;font-family:monospace;font-size:11px;color:#ffe066;}
    .tmit-onboard-input{width:100%;background:rgba(0,0,0,0.5);border:1px solid rgba(151,2,173,0.3);border-radius:6px;color:#f0d5f8;font-family:monospace;font-size:13px;padding:9px 12px;outline:none;margin-bottom:8px;}
    .tmit-onboard-input:focus{border-color:#9702ad;}
    .tmit-onboard-validate{font-size:11px;font-family:monospace;min-height:16px;margin-bottom:8px;}
    .tmit-onboard-validate.ok{color:#50dc82;}
    .tmit-onboard-validate.err{color:#ff6060;}
    .tmit-onboard-validate.loading{color:#c9a227;}
    .tmit-onboard-capacity-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
    .tmit-onboard-cap-val{font-family:'Cinzel',serif;font-size:28px;color:#ffe066;font-weight:700;text-shadow:0 0 16px rgba(255,224,102,0.5);}
    .tmit-onboard-cap-detail{font-size:10px;color:#b481cc;line-height:1.6;}
    .tmit-onboard-tab-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;}
    .tmit-onboard-tab-card{background:rgba(0,0,0,0.3);border:1px solid rgba(151,2,173,0.15);border-radius:6px;padding:6px 8px;}
    .tmit-onboard-tab-card .tab-icon{font-size:16px;}
    .tmit-onboard-tab-card .tab-name{font-size:11px;font-weight:700;color:#c9a227;margin:3px 0 2px;}
    .tmit-onboard-tab-card .tab-desc{font-size:10px;color:#b481cc;line-height:1.5;}
    .tmit-onboard-footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px;}
    .tmit-onboard-dots{display:flex;gap:5px;}
    .tmit-onboard-dot{width:6px;height:6px;border-radius:50%;background:rgba(151,2,173,0.2);transition:background 0.2s;}
    .tmit-onboard-dot.active{background:#9702ad;}
    .tmit-onboard-btn{background:linear-gradient(90deg,#c9a227,#8b6e10);border:none;border-radius:6px;color:#09000d;font-weight:700;font-size:13px;padding:8px 20px;cursor:pointer;font-family:'Inter',sans-serif;transition:filter 0.15s;}
    .tmit-onboard-btn:hover{filter:brightness(1.15);}
    .tmit-onboard-btn:disabled{opacity:0.4;cursor:default;}
    .tmit-onboard-skip{font-size:11px;color:#9b7bb5;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;}
    .tmit-onboard-skip:hover{color:#7a2090;}
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
  const MAX_LIVE_ITEMS   = 50;
  const METADATA_TTL_MS  = 6 * 60 * 60 * 1000
  let   lastMetadataFetch = load('lastMetadataFetch', 0);

  // Fetch all items — metadata + market_value fallback prices
  // Cached for 6h in GM storage — most page loads skip this entirely
  async function fetchAllItems(apiKey) {
    const now = Date.now();
    // The RW temp seed (rw_* keys with market_value:0) only exists so the
    // War Gear tab has names to show before the first real poll. It must
    // NOT count as "we have a cached catalog" — if it did, we'd silently
    // suppress real torn/items errors on a fresh install and the snapshot
    // loop would iterate temp seeds with no prices and write nothing.
    // lastMetadataFetch is set only after a successful real fetch, so it
    // is the authoritative "do we have real items cached" signal.
    const hasRealMeta = lastMetadataFetch > 0;
    const isStale = (now - lastMetadataFetch) > METADATA_TTL_MS;

    if (hasRealMeta && !isStale) return {};

    try {
      const data = await apiGetWithTimeout(
        `https://api.torn.com/torn/?selections=items&key=${apiKey}&comment=TEEM`,
        20000
      );
      if (data?._error) {
        if (hasRealMeta) return {};
        throw new Error('Torn API unreachable — check your connection');
      }
      if (data?.error) {
        if (hasRealMeta) return {};
        throw new Error(`Torn API error ${data.error.code}: ${data.error.error}`);
      }
      const items = data?.items ?? {};
      if (Object.keys(items).length > 0) {
        lastMetadataFetch = now;
        store('lastMetadataFetch', now);
        return items;
      }
      if (hasRealMeta) return {};
      throw new Error('Torn API returned no items');
    } catch(e) {
      if (hasRealMeta) return {}
      throw e
    }
  }

  // Fetch live lowest-listing price for a single item (average of lowest 5)
  async function fetchLivePrice(apiKey, itemId) {
    try {
      // Torn API v2 item market — the current live-listings endpoint.
      // The old v1 `market?selections=itemmarket` no longer returns the
      // live item-market listings, which left every item stuck on a stale
      // 6-hour average and showing 0% movement.
      const data = await apiGetWithTimeout(
        `https://api.torn.com/v2/market/${itemId}/itemmarket?key=${apiKey}&comment=TEEM`,
        6000
      );
      if (!data || data._error || data.error) return 0;
      // v2 shape: { itemmarket: { item:{...}, listings:[{price,amount},...] } }
      let listings = data?.itemmarket?.listings;
      // tolerate object-keyed shapes just in case
      if (!Array.isArray(listings)) {
        const im = data?.itemmarket;
        if (im && typeof im === 'object') {
          listings = Object.values(im).filter(v => v && typeof v === 'object' && (v.price || v.cost));
        }
      }
      if (!Array.isArray(listings) || !listings.length) return 0;
      const prices = listings
        .map(l => l.price ?? l.cost ?? 0)
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
    // Items currently shown in the panel — prioritized by activity so the
    // view the user is looking at gets live prices, but stagnant items
    // don't crowd out movers. Cold items rotate in every 3rd poll, so a
    // large category eventually gets full coverage without exceeding the
    // per-poll API budget.
    const viewItems = lastRenderedIds.map(id => {
      if (!Number.isFinite(id)) return null;
      const r = analysisCache.find(x => x.itemId === id);
      // Bootstrap urgency: no analysis or thin data → highest priority
      if (!r || r.thinData) return { id, score: 1e6 };
      // Movement priority: |changePct| as score (movers win slots)
      return { id, score: Math.abs(r.changePct || 0) };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    for (const { id, score } of viewItems) {
      if (ids.size >= MAX_LIVE_ITEMS) break;
      // Cold items (no meaningful movement) only fetched every 3rd poll
      if (score < 1 && pollCounter % 3 !== 0) continue;
      ids.add(id);
    }
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
    const deadline = Date.now() + 35000;
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

    // Signal logic — Torn-flipper semantics (buy low, sell high).
    // SELL on strength: price rising → cash out the spike.
    // BUY on weakness: price dipping → accumulate at a discount.
    // This is the opposite of momentum trading and matches how Torn
    // players actually use the market.
    let signal = 'WATCH';
    let confidence = 1;

    if (changePct > 5 && trendPct > 0) {
      signal = 'SELL'; confidence = Math.min(3, Math.floor(changePct / 5));
    } else if (changePct < -8 && trendPct < 0) {
      signal = 'BUY';  confidence = Math.min(3, Math.floor(Math.abs(changePct) / 8));
    } else if (changePct > 2) {
      signal = 'HOLD'; confidence = 2; // mild rise — hold for more upside before selling
    } else if (Math.abs(changePct) < 1 && volatility > 8) {
      signal = 'WATCH'; confidence = 2;
    }

    // Big spike detection — require >=3 snapshots before trusting a spike.
    // The first live snapshot after a stale market_value can look like a
    // 50% "jump" that's really just a data-source switch, not real movement.
    // isBigSpike (50%+) drives the FAB badge: a real act-now-or-miss-it
    // move. The previous 30% threshold produced too many false alerts.
    const trustworthy = effectiveWindow.length >= 3;
    const isSpike = trustworthy && Math.abs(changePct) > 15;
    const isBigSpike = trustworthy && Math.abs(changePct) > 50;

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

    // Alert if any big spikes (50%+ moves) — gated by the spikeAlertEnabled
    // setting (treat undefined as enabled so existing users keep the
    // default). The badge color reflects the item-type of the biggest spike
    // so the user can tell at a glance whether it's drugs, weapons, etc.
    const bigSpikes = results.filter(r => r.isBigSpike);
    const wantAlert = settings.spikeAlertEnabled !== false && bigSpikes.length > 0;
    const fab = document.getElementById('tmit-fab');
    const badge = document.getElementById('tmit-alert-badge');

    if (wantAlert) {
      // Pick the spike with the largest absolute move — that's the type
      // we want to advertise on the badge.
      const top = bigSpikes.reduce(
        (best, r) => Math.abs(r.changePct) > Math.abs(best.changePct) ? r : best,
        bigSpikes[0]
      );
      const typeClass = badgeTypeClass(top.type);
      if (!alertActive) {
        alertActive = true;
        fab?.classList.add('tmit-alert');
      }
      if (badge && badge.dataset.typeClass !== typeClass) {
        // Replace any previous type-* class without touching unrelated ones.
        badge.className = 'tmit-alert-badge' + (typeClass ? ' ' + typeClass : '');
        badge.dataset.typeClass = typeClass;
        badge.textContent = badgeIconForType(top.type);
        badge.title = `${top.name} ${top.changePct > 0 ? '+' : ''}${top.changePct}%`;
      }
    } else if (alertActive) {
      alertActive = false;
      fab?.classList.remove('tmit-alert');
    }

    return results;
  }

  // Map a raw Torn item type to a badge CSS class. Returns '' if no match —
  // the badge falls back to its default gold styling.
  function badgeTypeClass(type) {
    if (!type) return '';
    const t = String(type).toLowerCase();
    if (t === 'drug')                                                 return 'type-drug';
    if (t === 'medical')                                              return 'type-medical';
    if (t === 'plushie')                                              return 'type-plushie';
    if (t === 'flower')                                               return 'type-flower';
    if (t === 'booster')                                              return 'type-booster';
    if (t === 'energy drink')                                         return 'type-energy';
    if (t === 'alcohol')                                              return 'type-alcohol';
    if (t === 'special')                                              return 'type-special';
    if (RW_ARMOR_TYPE_LOWER.has(t) || t === 'defensive')              return 'type-armor';
    if (RW_WEAPON_TYPE_LOWER.has(t) || t === 'temporary')             return 'type-weapon';
    return '';
  }

  // Pick a micro-icon for the badge based on item type. Pairs with the
  // colored background to give the user both a category color AND a
  // recognizable symbol at a glance — no need to open the panel to know
  // whether it's drugs, weapons, plushies, etc.
  //
  // These are monochrome Unicode glyphs (not emoji) so they render in the
  // badge's CSS `color` (black) instead of full-color emoji. The "︎"
  // suffix on ⚡ and ⚔ forces the text presentation in fonts that would
  // otherwise render them as colored emoji.
  function badgeIconForType(type) {
    if (!type) return '$';
    const t = String(type).toLowerCase();
    if (t === 'drug')                                                 return '℞';     // ℞ prescription
    if (t === 'medical')                                              return '✚';     // ✚ heavy cross
    if (t === 'plushie')                                              return '♥';     // ♥ heart
    if (t === 'flower')                                               return '✿';     // ✿ florette
    if (t === 'booster')                                              return '★';     // ★ star
    if (t === 'energy drink')                                         return '⚡︎'; // ⚡ lightning (text)
    if (t === 'alcohol')                                              return '⚜';     // ⚜ fleur-de-lis
    if (t === 'special')                                              return '✦';     // ✦ four-pointed star
    if (RW_ARMOR_TYPE_LOWER.has(t) || t === 'defensive')              return '⛨';     // ⛨ heraldic shield
    if (RW_WEAPON_TYPE_LOWER.has(t) || t === 'temporary')             return '⚔︎'; // ⚔ crossed swords (text)
    return '$';
  }

  async function poll(force = false) {
    if (!settings.apiKey) return;
    pollCounter++;
    const _pollStart = performance.now();
    const _sections = {};
    const _sec = (label) => {
      const now = performance.now();
      _sections[label] = now;
      return now;
    };

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

      _sec('beforeSnapshots');
      // Record price snapshots.
      // Iterate the union of itemMeta + livePrices + yataPrices keys so we
      // record snapshots even when torn/items has failed and itemMeta is
      // missing/only-temp-seeded. Without this, fetching live prices for
      // the 14 hardcoded ALWAYS_LIVE_IDS would still record zero snapshots
      // because the meta loop skipped all temp-seeded entries.
      // Priority: live listing > YATA > market_value
      // market_value is recorded only if it changed since last snapshot.
      const recordIds = new Set();
      for (const k of Object.keys(itemMeta)) {
        if (String(k).startsWith('rw_')) continue;
        const n = parseInt(k);
        if (Number.isFinite(n)) recordIds.add(n);
      }
      for (const k of Object.keys(livePrices)) {
        const n = parseInt(k);
        if (Number.isFinite(n)) recordIds.add(n);
      }
      for (const k of Object.keys(yataPrices)) {
        const n = parseInt(k);
        if (Number.isFinite(n)) recordIds.add(n);
      }

      for (const id of recordIds) {
        const meta      = itemMeta[id];
        const livePrice = livePrices?.[id] ?? 0;
        const yataPrice = yataPrices[id]   ?? 0;
        const mv        = meta?.market_value ?? 0;

        const tornPrice = livePrice || mv;
        if (tornPrice <= 0 && yataPrice <= 0) continue;

        // Lazy meta backfill: if we have a price for an ID with no metadata
        // (because torn/items failed), at least create a placeholder so it
        // shows up in the panel instead of vanishing.
        if (!itemMeta[id]) {
          itemMeta[id] = { name: `Item #${id}`, type: 'Unknown', market_value: mv };
        }

        if (!livePrice && mv > 0) {
          const hist = priceHistory[id];
          const lastMv = hist?.length ? hist[hist.length - 1].price : -1;
          if (mv === lastMv) {
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

      _sec('beforeAnalyze');
      recomputeTravel();
      // Always refresh analysisCache so the next poll's priority list and
      // spike alerts stay accurate. But skip the expensive DOM render and
      // travel-tab render unless the panel is actually visible — that's
      // what was making the script periodically hammer the main thread.
      runAnalysis();
      _sec('afterAnalyze');
      const panelEl = document.getElementById('tmit-panel');
      if (panelEl && !panelEl.classList.contains('tmit-hidden')) {
        renderList();
        if (settings.activeTab === 'travel') renderTravelTab();
      }
      _sec('end');

      // Log per-section timings only if poll took noticeable time. Tags
      // each section so we can see WHERE the time went, not just that the
      // poll was slow overall.
      const totalDur = performance.now() - _pollStart;
      if (totalDur > 200) {
        const parts = [];
        let prev = _pollStart;
        for (const [k, t] of Object.entries(_sections)) {
          parts.push(`${k}=${Math.round(t - prev)}ms`);
          prev = t;
        }
        console.warn(`[TEEM poll] ${Math.round(totalDur)}ms total — ${parts.join(', ')}`);
      }
    } catch(e) { setStatus('err', e.message.slice(0, 50)); }
  }

  async function pollStats() {
    if (!settings.apiKey) return;
    try {
      await fetchMyBattleStats(settings.apiKey);
      updateSessionTracker();
    } catch(e) { /* silent */ }
  }

  function startPolling() {
    // Clear any existing timers
    if (pollingTimer) clearInterval(pollingTimer);
    if (statsTimer)   clearInterval(statsTimer);

    // Floor the market poll at 60s — anything faster invites the
    // freeze/CPU-load issues we've spent days chasing. Default is 120s.
    const marketMs = Math.max(60, settings.marketPollSec ?? 120) * 1000;
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

  // ── DOM timer gating ────────────────────────────────────────────────────────
  // Polling and stats run continuously so the FAB spike-alert pulse still
  // fires when the panel is closed. The session bar and footer timers only
  // tick while the panel is open — they do nothing but update hidden DOM
  // when it's closed. The freeze that motivated sleep mode was actually
  // caused by infinite CSS animations on an opacity:0 panel, not by the
  // polling cadence itself.

  function suspendBackgroundWork() {
    if (backgroundSuspended) return;
    backgroundSuspended = true;
    if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    if (footerTimer)  { clearInterval(footerTimer);  footerTimer  = null; }
  }

  function resumeBackgroundWork() {
    if (!backgroundSuspended) return;
    if (!settings.apiKey) return;
    backgroundSuspended = false;
    if (!sessionTimer) sessionTimer = setInterval(updateSessionTracker, 15000);
    if (!footerTimer)  footerTimer  = setInterval(updateFooter, 30000);
  }

  // ── UI ────────────────────────────────────────────────────────────────────────

  function buildUI() {
    if (uiBuilt) return;
    uiBuilt = true;

    // FAB
    const fab = document.createElement('div');
    fab.id = 'tmit-fab';
    // Inline styles guarantee visibility even if the GM_addStyle stylesheet
    // fails to load or is blocked — the FAB must never be invisible.
    fab.style.cssText = 'position:fixed;bottom:28px;right:28px;width:52px;height:52px;'
      + 'border-radius:50%;background:radial-gradient(circle at 35% 35%,#320042,#09000d);'
      + 'border:2px solid #c9a227;cursor:pointer;display:flex;align-items:center;'
      + 'justify-content:center;z-index:2147483000;box-shadow:0 0 14px rgba(151,2,173,0.6),'
      + '0 4px 24px rgba(0,0,0,0.8);';
    fab.innerHTML = `<img src="${TEEM_ELEPHANT_DATAURL}" style="width:38px;height:38px;border-radius:50%;pointer-events:none;" draggable="false"><div class="tmit-alert-badge" id="tmit-alert-badge">$</div>`;
    fab.title = "TEEM — Torn's Elephant Economy Manager";
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'tmit-panel';
    panel.classList.add('tmit-hidden');
    panel.innerHTML = `
      <div class="tmit-header" id="tmit-drag-handle">
        <div class="tmit-title">
          <img src="${TEEM_ELEPHANT_DATAURL}" style="width:24px;height:24px;border-radius:50%;flex-shrink:0;" draggable="false">
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
          <span id="tmit-age-text" style="color:#9886b8;font-size:9px">—</span>
          <button class="tmit-btn-export" id="tmit-btn-export" title="Export current view to CSV">⬇ CSV</button>
        </div>
      </div>

      <div class="tmit-tab-bar">
        <div class="tmit-tab tmit-tab-active" data-tab="all">Market</div>
        <div class="tmit-tab" data-tab="watchlist">⭐ Watch <span class="tmit-tab-count" id="tmit-watch-count">0</span></div>
        <div class="tmit-tab" data-tab="war">⚔ War Gear</div>
        <div class="tmit-tab" data-tab="travel">✈ Travel</div>
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
        <div class="tmit-col-hdr"></div>
      </div>

      <div class="tmit-list" id="tmit-list">
        <div class="tmit-state-msg">
          <div class="tmit-state-icon">💎</div>
          ${settings.apiKey ? 'Fetching market data…' : 'Open ⚙ settings and enter your Torn API key.'}
        </div>
      </div>

      <!-- War Gear Tab -->
      <div id="tmit-war-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">⚔ War Gear Price Tracker</div>
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

      <!-- Travel Tab -->
      <div id="tmit-travel-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">✈ Travel Profit Rankings</div>

        <!-- Flight type + carry capacity -->
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px;padding:7px 9px;background:rgba(0,0,0,0.25);border-radius:6px;border:1px solid rgba(201,162,39,0.1);">
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="font-size:9px;color:#a294c0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Flight</span>
            <select id="tmit-flight-type" class="tmit-select" style="font-size:10px;">
              <option value="economy"  ${settings.flightType==='economy'  ?'selected':''}>✈ Economy</option>
              <option value="airstrip" ${settings.flightType==='airstrip' ?'selected':''}>🛫 Airstrip (−30%)</option>
              <option value="business" ${settings.flightType==='business' ?'selected':''}>💺 Business (−50%)</option>
              <option value="wlt"      ${settings.flightType==='wlt'      ?'selected':''}>🌟 WLT (−50%)</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="font-size:9px;color:#a294c0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Carry</span>
            <input type="number" id="tmit-travel-capacity" class="tmit-input-sm"
              value="${settings.carryCapacity || 10}" min="1" max="100" style="width:52px;font-size:11px;">
            <span style="font-size:9px;color:#a08fc0;">items</span>
          </div>
          <button class="tmit-btn-calc" style="margin:0;margin-left:auto;padding:4px 10px;font-size:10px;" id="tmit-travel-refresh">↻</button>
        </div>

        <!-- Alert conditions -->
        <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px;padding:6px 9px;background:rgba(0,0,0,0.2);border-radius:5px;border:1px solid rgba(201,162,39,0.08);">
          <span style="font-size:9px;color:#a294c0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Alert when:</span>
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
        <div id="tmit-travel-detail" style="font-size:11px;color:#ab9bce;padding:6px 0;">
          Click a destination above to see trip details.
        </div>
      </div>

      <!-- Quick Items Tab -->
      <div id="tmit-quick-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">⚡ Quick Use Items</div>
        <div style="font-size:10px;color:#a08fc0;margin-bottom:10px;line-height:1.6;">
          Pin items here for fast access. TEEM injects a bar at the top of the
          <a href="https://www.torn.com/item.php" style="color:#c9a227;text-decoration:none;">Items page</a>
          with your saved items. Clicking one scrolls directly to that item —
          if you're elsewhere, TEEM navigates there automatically.
        </div>
        <div style="display:flex;gap:6px;margin-bottom:10px;">
          <input type="text" id="tmit-quick-add-name" placeholder="e.g. Xanax"
            class="tmit-input-full" style="flex:1;">
          <button class="tmit-btn-calc" style="margin:0;padding:5px 10px;" id="tmit-quick-add-btn">+ Add</button>
        </div>
        <div id="tmit-quick-list" style="display:flex;flex-direction:column;gap:6px;"></div>
      </div>

      <div class="tmit-settings-panel" id="tmit-settings-panel">
        <div class="tmit-settings-title">⚙ Settings</div>

        <div style="font-size:10px;color:#a08fc0;line-height:1.6;margin-bottom:10px;padding:6px 8px;background:rgba(201,162,39,0.05);border:1px solid rgba(201,162,39,0.12);border-radius:5px;">
          All keys are stored locally on your device only — never sent anywhere except directly to that service's own API.
          <b style="color:#c9a227">Create a separate key per service</b> so you can revoke them individually if needed.
        </div>

        <!-- TORN MARKET API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          Torn Market API Key <span style="color:#ff6060;font-weight:400;">★ Required</span>
        </div>
        <div style="font-size:9px;color:#a08fc0;margin-bottom:5px;line-height:1.5;">
          Used for live item prices, your stats, and carry-capacity detection.
          Get yours at <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">torn.com → Preferences → API ↗</a>
          — a <b style="color:#e8dff5">Limited</b> key is enough.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-apikey-input" placeholder="Paste Torn API key here…"
            value="${settings.apiKey}" autocomplete="off"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-apikey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#a294c0;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">👁</button>
        </div>
        <div id="tmit-apikey-status" style="font-size:10px;min-height:14px;margin-bottom:8px;padding-left:2px;"></div>


        <!-- YATA API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          YATA API Key <span style="color:#a294c0;font-weight:400;">Optional</span>
        </div>
        <div style="font-size:9px;color:#a08fc0;margin-bottom:5px;line-height:1.5;">
          Unlocks <b style="color:#e8dff5">YATA spy data</b> for player overlays and more accurate travel stock estimates.
          Log in at <a href="https://yata.life" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">yata.life ↗</a>
          with your Torn account — your YATA key is in your profile settings there.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-yata-key-input" placeholder="Paste YATA key here…" autocomplete="off" value="${load('yataKey', '')}"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-yatakey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#a294c0;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">👁</button>
        </div>
        <div id="tmit-yata-key-status" style="font-size:10px;min-height:14px;margin-bottom:10px;padding-left:2px;"></div>

        <!-- ALERTS -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:6px;margin-top:4px;">
          Alerts
        </div>
        <label style="display:flex;align-items:center;gap:8px;font-size:11px;color:#d8c8f0;cursor:pointer;margin-bottom:10px;padding:6px 8px;background:rgba(0,0,0,0.25);border:1px solid rgba(151,2,173,0.15);border-radius:5px;">
          <input type="checkbox" id="tmit-spike-alert" ${settings.spikeAlertEnabled !== false ? 'checked' : ''}
            style="accent-color:#c9a227;cursor:pointer;">
          <span style="flex:1;">Show a coin badge on the elephant for huge spikes <span style="color:#a08fc0;font-size:10px;">(50%+ price moves; color-coded by item type)</span></span>
        </label>

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
    // footerTimer is started by resumeBackgroundWork() when the panel opens

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
          <button id="tmit-ob-close-x" style="margin-left:auto;background:none;border:none;color:#9886b8;font-size:16px;cursor:pointer;padding:0;line-height:1;" title="Close (set up later via ⚙ in the panel)">✕</button>
        </div>

        <!-- Step 1: API Key -->
        <div class="tmit-onboard-step active" id="tmit-ob-step-1">
          <div class="tmit-onboard-step-title">Step 1 of 4 — Connect to Torn</div>
          <div class="tmit-onboard-step-body">
            TEEM needs a <b>Torn API key</b> to fetch live market prices and your carry capacity.<br><br>
            A <b>Limited</b> key is enough - just enable <code>Market</code>, <code>User</code>, and <code>Torn</code> access when creating it.
          </div>
          <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener"
            style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;padding:7px 14px;background:rgba(201,162,39,0.12);border:1px solid rgba(201,162,39,0.3);border-radius:6px;color:#ffe066;font-size:11px;font-weight:700;text-decoration:none;transition:background 0.15s;"
            onmouseover="this.style.background='rgba(201,162,39,0.22)'"
            onmouseout="this.style.background='rgba(201,162,39,0.12)'">
            🔑 Open Torn API Settings (new tab) ↗
          </a>
          <div style="font-size:10px;color:#a08fc0;margin-bottom:8px;">
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
              <label style="font-size:11px;color:#a294c0;white-space:nowrap;">Adjust if wrong:</label>
              <input type="number" id="tmit-ob-cap-input" min="1" max="100"
                style="width:70px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.3);border-radius:5px;color:#ffe066;font-family:monospace;font-size:16px;font-weight:700;padding:4px 8px;outline:none;text-align:center;"
                placeholder="29">
              <span style="font-size:10px;color:#a08fc0;">items per trip</span>
            </div>
            <div style="font-size:10px;color:#a08fc0;">You can always change this in the ✈ Travel tab.</div>
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
              <div class="tab-desc">Live market prices for ranked war weapons & armor, with BB trade-in values.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">⚡</div>
              <div class="tab-name">Quick</div>
              <div class="tab-desc">Pin items for one-click access from the Torn Items page.</div>
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

    // NOTE: the API settings page is opened only when the user clicks the
    // "Open Torn API Settings" button above. Auto-opening it caused an
    // infinite tab loop — the new torn.com tab re-ran onboarding and
    // auto-opened another tab, endlessly.

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
    // Resume background polling + session/footer timers. If they were already
    // running this is a no-op. If we were suspended (panel was hidden), this
    // also kicks off an immediate poll so the user sees fresh data.
    resumeBackgroundWork();
    updateSessionTracker();
    updateFooter();
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
          if (panel.classList.contains('tmit-hidden')) {
            openPanel(fab, panel);
          } else {
            panel.classList.add('tmit-hidden');
            suspendBackgroundWork();
          }
        }
        fabDragging = false;
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
    });

    panel.querySelector('#tmit-btn-close').addEventListener('click', () => {
      panel.classList.add('tmit-hidden');
      suspendBackgroundWork();
    });

    // Refresh
    panel.querySelector('#tmit-btn-refresh').addEventListener('click', () => poll(true));

    // Eye toggle buttons — show/hide API key fields
    panel.addEventListener('click', (e) => {
      const toggleMap = {
        'tmit-apikey-toggle':  '#tmit-apikey-input',
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
      const yataInput = panel.querySelector('#tmit-yata-key-input');
      if (yataInput && !yataInput.value) yataInput.value = load('yataKey', '');
    });

    // Save settings
    panel.querySelector('#tmit-btn-save').addEventListener('click', () => {
      const key        = panel.querySelector('#tmit-apikey-input')?.value.trim()    || '';
      const yataKey    = panel.querySelector('#tmit-yata-key-input')?.value.trim() || '';
      const marketPoll = parseInt(panel.querySelector('#tmit-market-poll')?.value) || 60;
      const statsPoll  = parseInt(panel.querySelector('#tmit-stats-poll')?.value)  || 30;

      if (key)     { settings.apiKey = key; }
      if (yataKey) store('yataKey', yataKey);

      // Always save poll intervals and restart timers if changed
      const intervalsChanged = settings.marketPollSec !== marketPoll || settings.statsPollSec !== statsPoll;
      settings.marketPollSec = Math.max(15, marketPoll);
      settings.statsPollSec  = Math.max(10, statsPoll);
      saveSettings();

      if (intervalsChanged && settings.apiKey) startPolling();

      // Feedback
      const saved = [key && 'Torn', yataKey && 'YATA'].filter(Boolean);
      if (saved.length) {
        const statusEl = document.getElementById('tmit-apikey-status');
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

    // Search — debounced so a full re-render doesn't fire on every keystroke
    let searchDebounce;
    panel.querySelector('#tmit-search').addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(renderList, 200);
    });

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
        // Soft guard: warn if user doesn't appear to own the item, but
        // still navigate (inventory cache can be stale by up to one poll)
        const id    = parseInt(sellBtn.dataset.id);
        const owned = userInventory[id]?.quantity ?? 0;
        const name  = sellBtn.dataset.name;
        if (!owned) showTeemNotice(`No ${name} in your last inventory snapshot — opening Items page anyway`);
        attemptQuickUse(name);
      }
    });

    // Quick items tab — add / remove / use
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
      // Use button on a pinned row — fires the full Quick Use flow, even
      // from the panel. attemptQuickUse handles cross-page navigation.
      const useBtn = e.target.closest('[data-quick-use]');
      if (useBtn && !useBtn.disabled) {
        const idx = parseInt(useBtn.dataset.quickUse);
        const item = quickItems[idx];
        if (item) attemptQuickUse(item.name);
        return;
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
      if (e.target.id === 'tmit-spike-alert') {
        settings.spikeAlertEnabled = e.target.checked;
        saveSettings();
        // If disabling while currently pulsing, stop immediately —
        // don't wait for the next poll to clear the animation.
        if (!e.target.checked && alertActive) {
          alertActive = false;
          document.getElementById('tmit-fab')?.classList.remove('tmit-alert');
        }
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
    const warPanel    = document.getElementById('tmit-war-panel');
    const travelPanel = document.getElementById('tmit-travel-panel');
    const quickPanel  = document.getElementById('tmit-quick-panel');

    const isMarket = tab === 'all' || tab === 'watchlist';
    if (controls)     controls.style.display    = isMarket ? '' : 'none';
    if (filterRow)    filterRow.style.display   = isMarket ? '' : 'none';
    if (colHeaders)   colHeaders.style.display  = isMarket ? '' : 'none';
    if (listEl)       listEl.style.display      = isMarket ? '' : 'none';
    if (warPanel)     warPanel.style.display    = tab === 'war'    ? 'flex' : 'none';
    if (travelPanel)  travelPanel.style.display = tab === 'travel' ? 'flex' : 'none';
    if (quickPanel)   quickPanel.style.display  = tab === 'quick'  ? 'flex' : 'none';

    // Update active tab highlight
    document.querySelectorAll('.tmit-tab').forEach(t =>
      t.classList.toggle('tmit-tab-active', t.dataset.tab === tab)
    );

    if (isMarket)           renderList();
    else if (tab === 'war')    renderWarTab();
    else if (tab === 'quick')  renderQuickTab();
    else if (tab === 'travel') renderTravelTab();
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
          <div class="tmit-result-row"><span class="tmit-result-label">Revenue / Trip</span><span class="tmit-result-val">$${item ? Math.round(item.netSellPrice * item.actualCap).toLocaleString() : '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Cost / Trip (buy)</span><span class="tmit-result-val icy">−$${item ? Math.round(item.buyPrice * item.actualCap).toLocaleString() : '—'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Net Profit / Trip</span><span class="tmit-result-val green">$${item ? Math.round(item.profitPerItem * item.actualCap).toLocaleString() : '—'}</span></div>
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

  function renderQuickTab() {
    const listEl = document.getElementById('tmit-quick-list');
    if (!listEl) return;
    if (!quickItems.length) {
      listEl.innerHTML = '<div style="font-size:10px;color:#9886b8;padding:8px 0;">'
        + 'No items pinned yet. Add some above — they\'ll appear here AND on the Items page.</div>';
      return;
    }
    listEl.innerHTML = quickItems.map((item, idx) => {
      const qty = getInventoryQty(item.name);
      const disabled = qty === 0;
      const useBg = disabled
        ? 'background:rgba(80,60,90,0.25);border:1px solid rgba(120,100,140,0.3);'
            + 'color:#7a6c8a;cursor:not-allowed;'
        : 'background:linear-gradient(180deg,#3a0050,#1a0020);'
            + 'border:1px solid #9702ad;color:#ff7a1f;cursor:pointer;'
            + 'box-shadow:0 0 8px rgba(151,2,173,0.3);';
      return `
        <div style="display:flex;align-items:center;gap:8px;padding:7px 10px;
                    background:rgba(0,0,0,0.25);border-radius:6px;border:1px solid rgba(201,162,39,0.12);">
          <button data-quick-use="${idx}" ${disabled ? 'disabled' : ''}
            title="${disabled ? 'You have 0 of these' : 'Use ' + item.name + ' now'}"
            style="${useBg}border-radius:5px;font-size:10px;font-weight:700;
                   letter-spacing:0.08em;padding:4px 10px;font-family:'Cinzel',serif;">
            ⚡ USE
          </button>
          <span style="flex:1;font-size:11px;color:#d8c8f0;font-weight:500;">${item.name}</span>
          <span style="font-size:11px;font-family:monospace;color:${disabled ? '#ff6060' : '#c9a227'};font-weight:700;">
            (${qty})
          </span>
          <button data-quick-remove="${idx}"
            title="Unpin"
            style="font-size:11px;color:#ff6060;background:none;border:none;cursor:pointer;
                   padding:2px 6px;opacity:0.6;">✕</button>
        </div>
      `;
    }).join('');
  }

  function renderWarTab() {
    const listEl = document.getElementById('tmit-war-tracker-list');
    if (!listEl) return;

    // Build war item list from itemMeta merged with analysisCache for price + changePct
    const priceMap     = {};
    const changePctMap = {};
    for (const r of analysisCache) {
      priceMap[r.name]     = r.currentPrice;
      changePctMap[r.name] = r.changePct ?? 0;
    }

    const warItems = Object.values(itemMeta)
      .filter(m => isRWItem(m.name, m.type))
      .map(m => ({
        name:         m.name,
        type:         m.type,
        currentPrice: priceMap[m.name] ?? m.market_value ?? 0,
        changePct:    changePctMap[m.name] ?? 0,
      }));

    if (warItems.length === 0) {
      listEl.innerHTML = `<div class="tmit-state-msg" style="padding:16px 0;">
        <div class="tmit-state-icon" style="font-size:20px">⚔</div>
        No war gear detected yet in market data.<br>
        <span style="font-size:10px;color:#9886b8">War weapons and armor will appear here as price history accumulates.</span>
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
          <div style="font-size:9px;color:#9886b8">${r.type}${weapType ? ' · '+weapType : ''}</div>
        </div>
        <div class="tmit-war-price" style="text-align:right">$${r.currentPrice >= 1_000_000
          ? (r.currentPrice/1_000_000).toFixed(1)+'M'
          : r.currentPrice.toLocaleString()}</div>
        <div class="tmit-war-bb" style="text-align:right">${bbVal ? bbVal+' BB' : '—'}</div>
        <div style="text-align:right;font-size:10px;color:#50dc82">${bbDollar}</div>
        <div class="${changeClass}" style="text-align:right">${changeSign}${Number(r.changePct).toFixed(1)}%</div>
      </div>`;
    });

    listEl.innerHTML = rows.join('');
  }

  // ── Market List ────────────────────────────────────────────────────────────

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

    // Cap rendered rows so the periodic DOM rebuild can't freeze the tab.
    // Beyond ~200 items a human can't visually scan anyway; sorted by
    // absolute change %, the top slice is also the most actionable.
    const MAX_RENDERED_ROWS = 200;
    const totalMatched = filtered.length;
    const truncated = totalMatched > MAX_RENDERED_ROWS;
    if (truncated) filtered = filtered.slice(0, MAX_RENDERED_ROWS);

    // Remember which items are on screen so the next poll fetches live prices
    // for exactly the view the user is looking at
    lastRenderedIds = filtered.map(r => r.itemId).filter(Number.isFinite);

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
              title="Buy on market" style="color:#3dd6c8;">🛒</button>
            <button class="tmit-row-btn tmit-sell-btn" data-id="${r.itemId}" data-name="${r.name}"
              title="List on market (opens Items page)" style="color:#e8621a;">💵</button>
          </div>
        </div>`;
    });

    const overflowMsg = truncated
      ? `<div style="padding:14px 16px;text-align:center;font-size:11px;color:#a08fc0;border-top:1px solid rgba(151,2,173,0.18);background:rgba(0,0,0,0.25);">
           Showing top <b style="color:#c9a227">${MAX_RENDERED_ROWS}</b> of <b style="color:#c9a227">${totalMatched.toLocaleString()}</b> items
           — narrow down with search, category or filters to see more.
         </div>`
      : '';
    listEl.innerHTML = rows.join('') + overflowMsg;
    document.getElementById('tmit-item-count').textContent = truncated
      ? `${MAX_RENDERED_ROWS}/${totalMatched.toLocaleString()}`
      : filtered.length;
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
    // Skip work when the panel is hidden — the session bar isn't visible
    // and iterating the full priceHistory every 15s on a backgrounded
    // panel is what was causing the periodic freezing.
    const panelEl = document.getElementById('tmit-panel');
    if (!panelEl || panelEl.classList.contains('tmit-hidden')) return;

    const invEl    = document.getElementById('tmit-sess-inv');
    const profitEl = document.getElementById('tmit-sess-profit');
    const ageDotEl = document.getElementById('tmit-age-dot');
    const ageTextEl = document.getElementById('tmit-age-text');

    // Recompute session profit fresh on each call — (current - session-start) per item
    let computedProfit = 0;
    for (const [idStr, hist] of Object.entries(priceHistory)) {
      if (!hist.length) continue;
      const latest = hist[hist.length - 1];
      const price = latest.price || latest.yataPrice || 0;
      if (price > 0) {
        if (!sessionStartPrices[idStr]) sessionStartPrices[idStr] = price;
        computedProfit += (price - sessionStartPrices[idStr]);
      }
    }
    sessionProfit = computedProfit;

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
    // Skip when the panel is hidden — nothing the user can see.
    const panelEl = document.getElementById('tmit-panel');
    if (!panelEl || panelEl.classList.contains('tmit-hidden')) return;

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

    // ── Diagnostics ─────────────────────────────────────────────────────
    // These help isolate the source of any periodic UI freezes. They log
    // to the browser console (F12 → Console), tagged with [TEEM …] so
    // they're easy to spot.
    try {
      // 1) One-shot startup: how much data have we accumulated?
      const itemCount = Object.keys(priceHistory).length;
      const snapCount = Object.values(priceHistory).reduce((a, h) => a + h.length, 0);
      const approxKB  = Math.round(JSON.stringify(priceHistory).length / 1024);
      console.warn(`[TEEM] priceHistory: ${itemCount} items, ${snapCount} snapshots, ~${approxKB}KB`);
      console.warn(`[TEEM] itemMeta: ${Object.keys(itemMeta).length} entries`);
    } catch(e) {}

    // 2) Watchdog: detects main-thread freezes from any source. Ticks
    //    every 250ms; if more than 750ms passed since last tick, the
    //    main thread was blocked for at least 500ms. Logs the gap and
    //    a timestamp so we can correlate with the poll cadence.
    let _watchdogLast = Date.now();
    setInterval(() => {
      const now = Date.now();
      const gap = now - _watchdogLast;
      _watchdogLast = now;
      if (gap > 750) {
        console.warn(`[TEEM watchdog] Main thread blocked ~${gap - 250}ms at ${new Date().toLocaleTimeString()}`);
      }
    }, 250);

    // Keyboard shortcut Alt+T to toggle panel
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 't') {
        const panel = document.getElementById('tmit-panel');
        const fab   = document.getElementById('tmit-fab');
        if (panel && fab) {
          if (panel.classList.contains('tmit-hidden')) {
            openPanel(fab, panel);
          } else {
            panel.classList.add('tmit-hidden');
            suspendBackgroundWork();
          }
        }
      }
    });

    // Notification permission request (needed for travel + spike alerts)
    if (Notification.permission === 'default') { Notification.requestPermission(); }

    // Flush throttled history save on tab close so we don't lose snapshots
    // accumulated since the last idle save.
    window.addEventListener('beforeunload', () => {
      try { saveHistoryNow(); } catch(e) {}
    });

    // Catch-up poll when the tab regains focus. Browsers throttle and
    // sometimes freeze setInterval in backgrounded tabs, which would leave
    // prices stale until the next active tick. Refresh immediately on
    // refocus, but throttle to no more than once per 30s.
    let lastVisPoll = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!settings.apiKey) return;
      if (Date.now() - lastVisPoll < 30000) return;
      lastVisPoll = Date.now();
      poll();
    });

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
      // Polling runs from script load so the FAB spike-alert can pulse
      // even when the panel is closed. Session/footer DOM timers stay
      // gated to panel-open via resumeBackgroundWork() in openPanel().
      startPolling();
    }

    // Fetch my own battlestats on startup (silently)
    if (settings.apiKey) { setTimeout(() => fetchMyBattleStats(settings.apiKey), 3000); }
  }

  // ── Page injector — quick bar ─────────────────────────────────────────────

  // Inject the Quick Use bar at the top of the Items page. Styled as a
  // purple box with a neon-orange "QUICK USE" header, each pinned item
  // shown as a button with its live inventory count. Items the user has
  // zero of are disabled and dimmed.
  function injectQuickBar() {
    if (!window.location.href.includes('item.php')) return;
    if (document.getElementById('teem-quick-bar')) return;
    if (!quickItems.length) return;

    const bar = document.createElement('div');
    bar.id = 'teem-quick-bar';
    bar.style.cssText = [
      'position:fixed', 'top:62px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:99999', 'display:flex', 'align-items:center', 'gap:10px',
      'padding:9px 16px',
      // Purple gradient box
      'background:linear-gradient(180deg,#3a0050 0%,#1a0020 100%)',
      'border:2px solid #9702ad',
      'border-radius:10px',
      'box-shadow:0 0 18px rgba(151,2,173,0.45),0 8px 24px rgba(0,0,0,0.7),inset 0 1px 0 rgba(255,224,102,0.18)',
      "font-family:'Inter',sans-serif",
      'max-width:92vw', 'flex-wrap:wrap',
    ].join(';') + ';';

    // Neon-orange "QUICK USE" header with glow
    const header =
      '<span style="font-family:\'Cinzel\',serif;font-size:13px;font-weight:700;'
      + 'letter-spacing:0.12em;color:#ff7a1f;'
      + 'text-shadow:0 0 12px rgba(255,122,31,0.75),0 0 4px rgba(255,122,31,0.5);'
      + 'white-space:nowrap;">⚡ QUICK USE</span>';

    // One button per pinned item, with live inventory count and a
    // disabled treatment when the user has none.
    const itemBtns = quickItems.map(item => {
      const qty = getInventoryQty(item.name);
      const disabled = qty === 0;
      const style = [
        'background:' + (disabled ? 'rgba(80,60,90,0.25)' : 'rgba(201,162,39,0.14)'),
        'border:1px solid ' + (disabled ? 'rgba(120,100,140,0.35)' : 'rgba(201,162,39,0.45)'),
        'border-radius:6px',
        'color:' + (disabled ? '#7a6c8a' : '#ffe066'),
        'font-size:12px', 'font-weight:600',
        'padding:5px 12px',
        'cursor:' + (disabled ? 'not-allowed' : 'pointer'),
        'font-family:inherit', 'white-space:nowrap',
        'transition:all 0.15s', 'opacity:' + (disabled ? '0.55' : '1'),
      ].join(';');
      const qtyColor = disabled ? '#ff6060' : '#a294c0';
      return '<button class="teem-quick-btn" data-item="' + item.name + '" '
        + (disabled ? 'disabled ' : '')
        + 'style="' + style + '">'
        + item.name
        + ' <span style="color:' + qtyColor + ';font-weight:400;">(' + qty + ')</span>'
        + '</button>';
    }).join('');

    const closeBtn =
      '<button id="teem-quick-bar-close" title="Hide bar (use TEEM panel ⚙ to re-enable)" '
      + 'style="background:none;border:none;color:#a08fc0;cursor:pointer;'
      + 'font-size:15px;padding:0 4px;margin-left:auto;line-height:1;">✕</button>';

    bar.innerHTML = header + itemBtns + closeBtn;
    document.body.appendChild(bar);

    bar.querySelector('#teem-quick-bar-close')?.addEventListener('click', () => bar.remove());

    // If we arrived here via a pinned-item click on a different page,
    // resume the action now that the items DOM is loaded.
    const pendingItem = sessionStorage.getItem('teem_quick_item');
    if (pendingItem) {
      sessionStorage.removeItem('teem_quick_item');
      setTimeout(() => attemptQuickUse(pendingItem), 900);
    }

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.teem-quick-btn');
      if (!btn || btn.disabled) return;
      attemptQuickUse(btn.dataset.item);
    });
  }

  // Quick Use: find an item by name on the Items page, expand its row,
  // click Use, and confirm the dialog. If the user is on any other page,
  // saves the action to sessionStorage and navigates to item.php — the
  // injectQuickBar's pending-item check on the next page will resume it.
  // Selectors are intentionally permissive because Torn's items page is
  // a React app with hash-suffixed class names that change over time.
  async function attemptQuickUse(itemName) {
    if (!window.location.href.includes('item.php')) {
      sessionStorage.setItem('teem_quick_item', itemName);
      window.location.href = 'https://www.torn.com/item.php';
      return false;
    }

    const targetLower = itemName.toLowerCase();

    // Step 1: Find the item row by exact name match.
    let row = null;
    for (const el of document.querySelectorAll('[class*="name"], .t-overflow, .name')) {
      if ((el.textContent || '').trim().toLowerCase() === targetLower) {
        row = el.closest('li, [class*="item"]');
        if (row) break;
      }
    }
    if (!row) {
      showTeemNotice(`Couldn't find "${itemName}" — out of stock or name changed`, 'err');
      return false;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const prevOutline = row.style.outline;
    row.style.outline = '2px solid #ff7a1f';
    setTimeout(() => { row.style.outline = prevOutline; }, 1500);

    // Step 2: Click the row to expand its action menu (Use/Send/Drop/…).
    row.click();

    // Helpers for finding action buttons by visible text. offsetParent
    // filters out hidden/collapsed elements.
    const findActionBtn = (texts, exclude) => {
      const wanted = texts.map(t => t.toLowerCase());
      for (const el of document.querySelectorAll('button, a, [role="button"], [class*="action"]')) {
        if (exclude && el === exclude) continue;
        if (!el.offsetParent) continue;
        const txt = (el.textContent || '').trim().toLowerCase();
        if (wanted.includes(txt)) return el;
      }
      return null;
    };
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // Step 3: Poll for the "Use" button — it appears after the row
    // animation expands the action panel. Up to ~1.2s.
    let useBtn = null;
    for (let i = 0; i < 8; i++) {
      await wait(150);
      useBtn = findActionBtn(['use', 'use item']);
      if (useBtn) break;
    }
    if (!useBtn) {
      showTeemNotice(`Found "${itemName}" but no Use button appeared`, 'err');
      return false;
    }
    useBtn.click();

    // Step 4: Some items (drugs, etc.) trigger a confirm dialog. Poll
    // briefly for it; if it never appears, the item used silently and
    // that's fine.
    for (let i = 0; i < 8; i++) {
      await wait(150);
      const confirmBtn = findActionBtn(['confirm', 'yes', 'ok'], useBtn);
      if (confirmBtn) { confirmBtn.click(); break; }
    }

    showTeemNotice(`✓ Used ${itemName}`, 'ok');
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
      <div style="font-size:10px;color:#a08fc0;margin-bottom:14px;">Price fields have been auto-filled.<br>Click Confirm to submit the listing.</div>
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

  function showTeemNotice(msg, variant) {
    const n = document.createElement('div');
    const palette = variant === 'ok'
      ? { border: 'rgba(80,220,130,0.5)', color: '#50dc82', glow: 'rgba(80,220,130,0.4)' }
      : variant === 'err'
      ? { border: 'rgba(255,96,96,0.5)', color: '#ff6060', glow: 'rgba(255,96,96,0.4)' }
      : { border: 'rgba(201,162,39,0.4)', color: '#c9a227', glow: 'rgba(201,162,39,0.3)' };
    n.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);'
      + 'z-index:999999;background:rgba(13,5,32,0.97);border:1.5px solid ' + palette.border + ';'
      + 'border-radius:8px;padding:10px 18px;font-family:\'Inter\',sans-serif;font-size:12px;font-weight:600;'
      + 'color:' + palette.color + ';box-shadow:0 0 14px ' + palette.glow + ',0 6px 20px rgba(0,0,0,0.6);'
      + 'letter-spacing:0.02em;';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2800);
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
