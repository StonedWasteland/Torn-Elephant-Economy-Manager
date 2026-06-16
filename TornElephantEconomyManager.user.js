// ==UserScript==
// @name         TEEM - Torn's Elephant Economy Manager
// @namespace    https://torn.com
// @version      6.8.0
// @description  TEEM - Torn's Elephant Economy Manager. Market signals, travel profit rankings (now with live YATA foreign prices), war gear pricing, and crime $/hour tracker. Mobile-friendly.
// @author       Wasteland
// @match        https://www.torn.com/*
// @updateURL    https://raw.githubusercontent.com/StonedWasteland/Torn-Elephant-Economy-Manager/main/TornElephantEconomyManager.meta.js
// @downloadURL  https://raw.githubusercontent.com/StonedWasteland/Torn-Elephant-Economy-Manager/main/TornElephantEconomyManager.user.js
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.torn.com
// @connect      yata.life
// @connect      yata.yt
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';
  try {


  const SCRIPT_KEY     = 'tmit_';
  const SCRIPT_VERSION = '6.8.1';

  // Torn PDA (mobile) runs userscripts inside a Flutter WebView. We detect it
  // so we can skip browser-only APIs (Notification) and switch the layout to
  // a near-fullscreen panel. GM_* and pointer events work fine on PDA.
  const IS_PDA = (typeof window !== 'undefined') && (
    !!window.flutter_inappwebview ||
    /Torn ?PDA/i.test(navigator.userAgent || '')
  );
  // Treat any narrow viewport as "mobile" for layout, even outside PDA — this
  // also covers desktop users who resize the window very small.
  const IS_MOBILE_VIEWPORT = (typeof window !== 'undefined') && window.innerWidth <= 768;

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
  // Travel countries — items identified by NAME, resolved to IDs at runtime.
  // `buyPrice` is the fixed in-store vendor price (stable for plushies, flowers,
  // grenades, suitcases). Items WITHOUT a `buyPrice` (drugs: Xanax/LSD/Opium)
  // have no fixed vendor — their abroad cost is whatever the foreign market is
  // currently asking, which we read live from YATA per poll. If YATA is down,
  // those entries are skipped (no fiction).
  // Travel times = one-way economy flight in minutes.
  // `capacity` = max units available per restock cycle, used as an upper bound
  // independent of YATA's reported live quantity.
  const COUNTRIES = [
    {
      name: 'Mexico', code: 'mex', flagEmoji: '\ud83c\uddf2\ud83c\uddfd', travelTime: 20,
      items: [
        { itemName: 'Jaguar Plushie', buyPrice: 10000, capacity: 400  },
        { itemName: 'Dahlia',         buyPrice: 300,   capacity: 1000 },
      ]
    },
    {
      name: 'Cayman Islands', code: 'cay', flagEmoji: '\ud83c\uddf0\ud83c\uddfe', travelTime: 57,
      items: [
        { itemName: 'Stingray Plushie', buyPrice: 400,  capacity: 400  },
        { itemName: 'Banana Orchid',    buyPrice: 4000, capacity: 1000 },
      ]
    },
    {
      name: 'Canada', code: 'can', flagEmoji: '\ud83c\udde8\ud83c\udde6', travelTime: 41,
      items: [
        { itemName: 'Wolverine Plushie', buyPrice: 30,  capacity: 400  },
        { itemName: 'Crocus',            buyPrice: 600, capacity: 1000 },
        { itemName: 'Xanax',                            capacity: 100  },
      ]
    },
    {
      name: 'Hawaii', code: 'haw', flagEmoji: '\ud83c\udf3a', travelTime: 121,
      items: [
        { itemName: 'Orchid',         buyPrice: 700,      capacity: 1000 },
        { itemName: 'Large Suitcase', buyPrice: 10000000, capacity: 100  },
      ]
    },
    {
      name: 'United Kingdom', code: 'uk', flagEmoji: '\ud83c\uddec\ud83c\udde7', travelTime: 159,
      items: [
        { itemName: 'Red Fox Plushie', buyPrice: 1000, capacity: 400  },
        { itemName: 'Nessie Plushie',  buyPrice: 200,  capacity: 400  },
        { itemName: 'Heather',         buyPrice: 5000, capacity: 1000 },
        { itemName: 'Xanax',                           capacity: 100  },
      ]
    },
    {
      name: 'Argentina', code: 'arg', flagEmoji: '\ud83c\udde6\ud83c\uddf7', travelTime: 189,
      items: [
        { itemName: 'Monkey Plushie', buyPrice: 400,   capacity: 400  },
        { itemName: 'Ceibo Flower',   buyPrice: 500,   capacity: 1000 },
        { itemName: 'Tear Gas',       buyPrice: 15000, capacity: 500  },
        { itemName: 'LSD',                             capacity: 100  },
      ]
    },
    {
      name: 'Switzerland', code: 'swi', flagEmoji: '\ud83c\udde8\ud83c\udded', travelTime: 169,
      items: [
        { itemName: 'Chamois Plushie', buyPrice: 400,   capacity: 400  },
        { itemName: 'Edelweiss',       buyPrice: 900,   capacity: 1000 },
        { itemName: 'Flash Grenade',   buyPrice: 12000, capacity: 500  },
        { itemName: 'LSD',                              capacity: 100  },
      ]
    },
    {
      name: 'Japan', code: 'jap', flagEmoji: '\ud83c\uddef\ud83c\uddf5', travelTime: 225,
      items: [
        { itemName: 'Cherry Blossom', buyPrice: 500, capacity: 1000 },
        { itemName: 'Xanax',                         capacity: 100  },
        { itemName: 'Opium',                         capacity: 100  },
      ]
    },
    {
      name: 'China', code: 'chi', flagEmoji: '\ud83c\udde8\ud83c\uddf3', travelTime: 219,
      items: [
        { itemName: 'Panda Plushie', buyPrice: 400,  capacity: 400  },
        { itemName: 'Peony',         buyPrice: 5000, capacity: 1000 },
        { itemName: 'LSD',                           capacity: 100  },
        { itemName: 'Opium',                         capacity: 100  },
      ]
    },
    {
      name: 'UAE', code: 'uae', flagEmoji: '\ud83c\udde6\ud83c\uddea', travelTime: 259,
      items: [
        { itemName: 'Camel Plushie',     buyPrice: 14000, capacity: 400  },
        { itemName: 'Tribulus Omanense', buyPrice: 6000,  capacity: 1000 },
      ]
    },
    {
      name: 'South Africa', code: 'saf', flagEmoji: '\ud83c\uddff\ud83c\udde6', travelTime: 297,
      items: [
        { itemName: 'Lion Plushie',   buyPrice: 400,  capacity: 400  },
        { itemName: 'African Violet', buyPrice: 2000, capacity: 1000 },
        { itemName: 'Xanax',                          capacity: 100  },
        { itemName: 'LSD',                            capacity: 100  },
        { itemName: 'Opium',                          capacity: 100  },
      ]
    },
  ];

  // YATA travel-export keys most countries by the same 3-letter code TEEM uses,
  // but ships 'uni' for the UK and 'sou' for South Africa. Map TEEM-internal
  // codes to whatever YATA uses so stock + price lookups match.
  const YATA_COUNTRY_CODE = {
    mex: 'mex', cay: 'cay', can: 'can', haw: 'haw',
    uk:  'uni', arg: 'arg', swi: 'swi', jap: 'jap',
    chi: 'chi', uae: 'uae', saf: 'sou',
  };
  const YATA_TO_TEEM = Object.fromEntries(
    Object.entries(YATA_COUNTRY_CODE).map(([teem, yata]) => [yata, teem])
  );

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

  function calcTravelProfit(country, marketPrices, yataStock, yataTravelPrices, carryCapacity) {
    const adjustedOneWay = getAdjustedTravelTime(country.travelTime);
    const roundTripHours = (adjustedOneWay * 2) / 60;
    const countryStock   = yataStock?.[country.code];
    const countryPrices  = yataTravelPrices?.[country.code];
    let bestItem = null, bestProfit = -Infinity;
    for (const item of country.items) {
      // Resolve ID from name at runtime
      const id = travelItemIdMap[item.itemName];
      if (!id) continue;
      const sellPrice = marketPrices[id] ?? 0;
      if (!sellPrice) continue;

      // Foreign buy price: live YATA cost preferred. Hardcoded `buyPrice` is
      // the vendor-fixed fallback (plushies, flowers, grenades, suitcases).
      // Items with no hardcoded buyPrice (drugs) MUST have a live YATA price —
      // otherwise we skip them rather than invent a number.
      const livePrice = countryPrices?.[id];
      const buyPrice  = (typeof livePrice === 'number' && livePrice > 0)
        ? livePrice
        : item.buyPrice;
      if (!buyPrice || buyPrice <= 0) continue;
      const priceSource = (typeof livePrice === 'number' && livePrice > 0) ? 'yata' : 'vendor';

      // Deduct 5% Torn sales tax from sell price
      const netSellPrice  = Math.round(sellPrice * 0.95);
      const profitPerItem = netSellPrice - buyPrice;
      if (profitPerItem <= 0) continue;

      // YATA returns raw available quantity. The effective cap is the minimum
      // of (your carry capacity, restock-cycle ceiling, live availability).
      // If YATA stock data is missing, fall back to optimistic full capacity.
      const stockQty       = countryStock?.[id];
      const haveStockData  = typeof stockQty === 'number';
      const availableCap   = haveStockData ? Math.min(stockQty, carryCapacity) : carryCapacity;
      const actualCap      = Math.min(availableCap, item.capacity, carryCapacity);
      if (actualCap <= 0) continue;

      const pph = (profitPerItem * actualCap) / roundTripHours;
      if (pph > bestProfit) {
        bestProfit = pph;
        bestItem = {
          ...item,
          itemName: item.itemName, // explicit so it survives even if some env mishandles the spread
          id, sellPrice, netSellPrice, buyPrice, profitPerItem, actualCap,
          stockQty: haveStockData ? stockQty : null,
          // Derived 0..1 stock fraction; keeps existing consumers (alerts, UI)
          // working while we migrate them to raw quantity where it's clearer.
          stockLevel: haveStockData ? Math.min(1.0, stockQty / Math.max(1, carryCapacity)) : 1.0,
          stockConf: haveStockData ? 'yata' : 'assumed',
          priceSource,
        };
      }
    }
    return {
      country: country.name, code: country.code, flagEmoji: country.flagEmoji,
      travelTime: country.travelTime, roundTripHours,
      profitPerHour: bestProfit > 0 ? Math.round(bestProfit) : 0,
      bestItem, viable: bestProfit > 0
    };
  }

  function rankTravelDestinations(marketPrices, yataStock, yataTravelPrices, carryCapacity) {
    return COUNTRIES
      .map(c => calcTravelProfit(c, marketPrices, yataStock, yataTravelPrices, carryCapacity))
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
    marketPollSec: 180,         // how often to fetch item prices (seconds) — floored at 60 in startPolling. v6.6.9 settled at 180s (was 120s through v6.6.7, briefly 240s in v6.6.8) — best balance of spike-alert latency and combined TEEM+TECH budget under Torn's 100/min.
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
    fabSize: 'normal',         // 'normal' | 'small' — double-click FAB on desktop to toggle
  });

  function saveSettings() { store('settings', settings); }

  // v6.6.9 — one-shot bump of any prior default market-poll value to 180s.
  // load() doesn't merge defaults into stored settings, so existing installs
  // keep whatever was stored even after the default constant changes. Two
  // prior default values are recognised: 120s (≤ v6.6.7) and 240s (v6.6.8
  // only). Any other value is assumed to be a deliberate choice and left
  // alone. New sentinel key — separate from the v6.6.8 attempt so users
  // who installed v6.6.8 still get corrected.
  (function migrateMarketPollDefault() {
    const SENTINEL = SCRIPT_KEY + 'migrated_market_poll_180';
    try {
      if (GM_getValue(SENTINEL)) return;
      if (settings.marketPollSec === 120 || settings.marketPollSec === 240) {
        settings.marketPollSec = 180;
        saveSettings();
      }
      GM_setValue(SENTINEL, { ts: Date.now() });
    } catch (e) {}
  })();

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
  // yataStockCache:        { teemCode: { itemId: rawQuantityAvailable } }
  // yataTravelPriceCache:  { teemCode: { itemId: currentCostAbroad } }
  // Both are populated together by the YATA travel-export fetch (poll()).
  let yataStockCache = null;
  let yataTravelPriceCache = null;

  function saveWatchlist() { store('watchlist', [...watchlist]); }

  // ── Session tracker ───────────────────────────────────────────────────────
  let sessionStartPrices = {}; // { itemId: price at session start }
  let sessionProfit     = 0;

  // ── Onboarding ────────────────────────────────────────────────────────────
  let onboardingDone  = load('onboardingDone', false);
  thinAllHistory()
  // Dollars per single Bunker Buck — used by the War Gear tab to convert
  // BB trade-in values into a $ equivalent. Storage key kept as `bbPerDollar`
  // for compatibility with installs from before the rename.
  let dollarsPerBB     = load('bbPerDollar', 7000000);
  let userInventory   = {};  // { itemId: { name, quantity, uid } } — refreshed each poll

  // ── Bazaar undercut tracker (v6.8.0) ──────────────────────────────────────
  // Lightweight snapshot of the cheapest Bazaar listing per item, populated
  // two ways:
  //   1. Background poll for watchlist items only (every BAZAAR_POLL_EVERY
  //      market cycles, capped at BAZAAR_WATCHLIST_CAP items)
  //   2. On-demand when the user clicks the 💰 button on any row
  // Stored as { itemId: { ts, cost, quantity } } — latest snapshot only,
  // no history. Entries silently expire after BAZAAR_TTL_MS for rendering;
  // we don't actively prune storage (~30 bytes per entry, negligible).
  let bazaarPrices = load('bazaarPrices', {});
  const BAZAAR_POLL_EVERY     = 5;                  // every 5th poll cycle
  const BAZAAR_WATCHLIST_CAP  = 15;                 // hard ceiling on auto-poll
  const BAZAAR_TTL_MS         = 30 * 60 * 1000;     // 30-min staleness cutoff
  const BAZAAR_MIN_UNDERCUT_PCT = 1;                // hide pill if < 1% below market
  let _bazaarInFlight = new Set();                  // dedupe concurrent on-demand clicks
  function saveBazaarPrices() { try { store('bazaarPrices', bazaarPrices); } catch(e) {} }

  // Crime tracker — snapshots of crimes + personalstats
  // taken on poll. Deltas between snapshots produce attempts/hour and
  // $/hour rates so we can recommend the top 3 crimes for the user's
  // current skill ceiling.
  let crimeSnapshots = load('crimeSnapshots', []);  // [{ ts, crimes: {...}, money?: number }]
  const CRIME_SNAPSHOT_MAX = 240;                   // ~24h at 6-min intervals
  let lastCrimeFetch = 0;
  // Throttle: don't fetch crimes more often than every 5 minutes — we don't
  // need second-by-second resolution and crimes data is the biggest field
  // in the user/ response.
  const CRIME_FETCH_INTERVAL_MS = 5 * 60 * 1000;

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
    confidence: 'Confidence dots show how strong the signal is.\n\u25cf \u25cf \u25cf = strong trend, lots of data.\n\u25cf \u25cf \u25cb = moderate.\n\u25cf \u25cb \u25cb = early/thin data.',
    pph:        'Profit Per Hour \u2014 estimated $ earned per hour of round-trip travel, after 5% sales tax.',
    stock:      'YATA \u2713 = live crowd-sourced stock data from yata.life.\n~stock = no data, assuming full stock (optimistic).',
    change:     'Price change % over your selected timeframe.\nOrange = price rising (hot). Teal = falling (cold).',
    dataAge:    'How long ago prices were last fetched. Green = fresh. Yellow = >5min old. Red = >15min.',
  };
  // ── Brand mark ─────────────────────────────────────────────────────────────
  // TEEM logo: purple-caparisoned elephant + cyan/orange "TEEM" wordmark.
  // Embedded as a 256x256 base64 JPEG (~16KB) for a self-contained script.
  // JPEG (not PNG) because the image is photographic and has no transparency
  // — the opaque black background lets the FAB show the logo edge-to-edge
  // without needing the underlying purple coin gradient to bleed through.
  // Used in the FAB, the panel title, and the onboarding card.
  const TEEM_ELEPHANT_DATAURL = "data:image/jpeg;base64,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";

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
    /* Rounded-square FAB showing the full logo JPEG (elephant + baked-in
       "TEEM" wordmark). The image div gets border-radius:inherit so its
       background gets clipped to the rounded shape \u2014 that way the FAB
       itself doesn't need overflow:hidden (which would also clip the
       alert badge that sits outside the corner). */
    #tmit-fab{position:fixed;bottom:28px;right:28px;width:84px;height:84px;border-radius:14px;background:#000;border:2px solid #c9a227;box-shadow:0 0 14px rgba(151,2,173,0.5),0 4px 24px rgba(0,0,0,0.8);cursor:pointer;z-index:999999;transition:all 0.3s ease;user-select:none;}
    #tmit-fab:hover{transform:scale(1.06);box-shadow:0 0 26px rgba(151,2,173,0.8),0 4px 28px rgba(0,0,0,0.9);}
    /* Half-size FAB — toggled by double-clicking the FAB (desktop). !important
       beats the inline width/height set in buildUI()'s cssText. */
    #tmit-fab.tmit-fab-small{width:42px !important;height:42px !important;border-radius:9px !important;}
    #tmit-fab .tmit-fab-elephant{position:absolute !important;top:0 !important;right:0 !important;bottom:0 !important;left:0 !important;background-size:100% 100% !important;background-position:center !important;background-repeat:no-repeat !important;border-radius:inherit !important;pointer-events:none;}
    /* Big-hit indicator: a static coin badge with the elephant on it.
       No animation, no transitions \u2014 just appears when a huge spike is
       detected. Toggling the .tmit-alert class is a single display swap,
       no per-frame work. Background color reflects the item-type of the
       biggest spike (set via .type-* class on the badge). */
    #tmit-fab .tmit-alert-badge{display:none;position:absolute;top:-10px;right:-10px;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#ffe680 0%,#c9a227 55%,#7a5d10 100%);border:2px solid #09000d;box-shadow:0 0 8px rgba(255,224,102,0.7),inset 0 1px 1px rgba(255,255,255,0.4);align-items:center;justify-content:center;font-size:12px;line-height:1;pointer-events:none;color:#000;font-weight:900;font-family:'Inter',sans-serif;z-index:2;}
    #tmit-fab.tmit-alert .tmit-alert-badge{display:flex;}
    /* Badge type colors \u2014 keyed to common Torn item categories. */
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
    .tmit-version{font-family:system-ui,sans-serif;font-size:10px;font-weight:600;color:#9702ad;letter-spacing:0.04em;margin-left:2px;text-shadow:none;text-transform:lowercase;}
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
    /* v6.7.4 — Tab panels are flex children of #tmit-panel and get
       display:flex set by switchTab(). Without an explicit direction the
       browser defaults to row, which laid out section title + header grid
       + data list as three side-by-side columns instead of stacking. The
       row content itself was rendering correctly — just into a flex
       column that was only ~80px wide. */
    .tmit-tab-panel{flex-direction:column;scrollbar-width:thin;scrollbar-color:rgba(151,2,173,0.5) rgba(255,255,255,0.04);}
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
    .tmit-signal-badge{display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.06em;padding:2px 6px;border-radius:3px;text-transform:uppercase;cursor:pointer;transition:all 0.15s;}
    .tmit-signal-badge:hover{filter:brightness(1.25);}
    .tmit-signal-badge.BUY{background:rgba(61,214,200,0.15);color:#3dd6c8;border:1px solid rgba(61,214,200,0.35);text-shadow:0 0 6px rgba(61,214,200,0.3);}
    .tmit-signal-badge.SELL{background:rgba(232,98,26,0.18);color:#ff8c42;border:1px solid rgba(232,98,26,0.4);text-shadow:0 0 6px rgba(232,98,26,0.4);}
    .tmit-signal-badge.HOLD{background:rgba(201,162,39,0.15);color:#c9a227;border:1px solid rgba(201,162,39,0.3);}
    .tmit-signal-badge.WATCH{background:rgba(151,2,173,0.12);color:#cc40f0;border:1px solid rgba(151,2,173,0.28);}
    .tmit-signal-badge.WATCH:hover{background:rgba(201,162,39,0.18);color:#ffe066;border-color:rgba(201,162,39,0.5);filter:none;}
    .tmit-signal-badge.tmit-watched{border-color:#c9a227 !important;box-shadow:0 0 7px rgba(201,162,39,0.45);}
    .tmit-signal-badge.WATCH.tmit-watched{background:rgba(201,162,39,0.22);color:#ffe066;}
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
    .tmit-war-row{display:grid;grid-template-columns:1fr 80px 80px 70px 55px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.04);align-items:center;font-size:11px;border-radius:3px;margin-bottom:1px;}
    .tmit-war-row:hover{background:rgba(151,2,173,0.05);}
    .tmit-war-row.yellow-item{border-left:2px solid #ffe066;}
    .tmit-war-row.orange-item{border-left:2px solid #e8621a;}
    .tmit-war-row.red-item{border-left:2px solid #ff4040;}
    .tmit-war-name{color:#e8caf5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .tmit-war-price{color:#a840c0;font-family:monospace;font-size:10px;text-align:right;}
    .tmit-war-bb{color:#ffe066;font-family:monospace;font-size:10px;text-align:right;}
    .tmit-war-chg{font-family:monospace;font-size:10px;font-weight:700;text-align:right;}
    /* v6.7.3 — War Gear sparkline + signal pill row. Sit in a meta row
       directly under the type, so the existing 5-column grid is preserved
       (no layout shifts in the right-side cells). Sparkline is an inline
       SVG sized to fit naturally inside the name cell. */
    .tmit-war-info{display:flex;flex-direction:column;gap:2px;overflow:hidden;min-width:0;}
    .tmit-war-meta{display:flex;align-items:center;gap:8px;margin-top:3px;
      min-height:14px;}
    .tmit-war-spark{display:inline-flex;align-items:center;flex:1;
      max-width:140px;min-width:50px;opacity:0.85;}
    .tmit-war-spark svg{display:block;width:100%;height:14px;}
    .tmit-war-spark.empty{color:#5f4a78;font-size:9px;font-style:italic;
      opacity:0.6;}
    /* War Gear signal badge — compact variant of the main-tab .tmit-signal-badge.
       Smaller font + denser padding so it fits in the meta row without pushing
       the sparkline. */
    .tmit-war-sig{display:inline-flex;align-items:center;gap:3px;
      font-family:monospace;font-size:9px;font-weight:700;letter-spacing:0.5px;
      padding:1px 5px;border-radius:3px;line-height:1.4;}
    .tmit-war-sig.BUY  {background:rgba(80,220,130,0.15);color:#50dc82;
      border:1px solid rgba(80,220,130,0.35);}
    .tmit-war-sig.SELL {background:rgba(255,64,64,0.15);color:#ff8080;
      border:1px solid rgba(255,64,64,0.35);}
    .tmit-war-sig.HOLD {background:rgba(255,224,102,0.12);color:#ffe066;
      border:1px solid rgba(255,224,102,0.30);}
    .tmit-war-sig.WATCH{background:rgba(128,176,255,0.12);color:#80b0ff;
      border:1px solid rgba(128,176,255,0.30);}
    .tmit-war-sig-dots{display:inline-flex;gap:2px;}
    .tmit-war-sig-dot{width:4px;height:4px;border-radius:50%;
      background:rgba(255,255,255,0.18);}
    .tmit-war-sig-dot.filled{background:currentColor;}
    /* v6.8.0 - Bazaar undercut tracker */
    .tmit-bazaar-pill{display:inline-flex;align-items:center;gap:3px;
      font-family:monospace;font-size:10px;font-weight:700;
      padding:1px 6px;border-radius:3px;line-height:1.4;
      background:rgba(255,201,77,0.13);color:#ffc94d;
      border:1px solid rgba(255,201,77,0.35);white-space:nowrap;}
    .tmit-bazaar-pill.compact{font-size:9px;padding:1px 5px;}
    .tmit-war-bazaar-btn{background:none;border:none;cursor:pointer;
      font-size:11px;padding:0 2px;opacity:0.9;color:#ffc94d;
      line-height:1;transition:opacity 0.15s,transform 0.15s;}
    .tmit-war-bazaar-btn:hover{opacity:1;transform:scale(1.15);}
    .tmit-war-bazaar-btn:disabled{cursor:default;opacity:0.4;}
    .tmit-bazaar-scan-btn{background:rgba(255,201,77,0.08);
      border:1px solid rgba(255,201,77,0.35);color:#ffc94d;
      border-radius:5px;padding:4px 10px;font-size:10px;font-weight:700;
      cursor:pointer;font-family:'Inter',sans-serif;letter-spacing:0.04em;
      transition:background 0.15s,border-color 0.15s;flex-shrink:0;}
    .tmit-bazaar-scan-btn:hover{background:rgba(255,201,77,0.18);
      border-color:rgba(255,201,77,0.6);}
    .tmit-bazaar-scan-btn:disabled{cursor:default;opacity:0.55;
      background:rgba(255,201,77,0.04);}
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
    .tmit-onboard-logo{width:56px;height:56px;margin:0 auto 14px;display:block;background-size:contain;background-position:center;background-repeat:no-repeat;}
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

    /* Tap-to-show tooltip class \u2014 paired with :hover so the same tooltip works on touch */
    .tmit-help.tmit-help-active::after{opacity:1;}

    /* Touch drag targets: stop the browser from interpreting the gesture as scroll/zoom */
    #tmit-fab,.tmit-header{touch-action:none;}

    /* Mobile / PDA layout \u2014 applies on narrow viewports (Torn PDA WebView,
       phones, or desktop windows resized small). Panel becomes near-fullscreen
       so the existing tab UI is usable on a phone screen. */
    @media (max-width: 768px){
      /* bottom:80px (not 18px) so Firefox Android's bottom URL bar can't
         hide the FAB. The URL bar overlays the viewport up to ~56px from
         the bottom on most FF Android builds; 80px gives clear separation. */
      #tmit-fab{width:64px;height:64px;bottom:80px;right:18px;border-radius:12px;}
      /* Small-variant mobile sizing if the setting was set on desktop and
         TM cloud-sync brought it over. Mobile gesture doesn't toggle this. */
      #tmit-fab.tmit-fab-small{width:36px !important;height:36px !important;border-radius:8px !important;}
      #tmit-panel{width:calc(100vw - 16px) !important;max-width:520px;max-height:calc(100vh - 100px);left:8px !important;right:auto !important;bottom:auto !important;}
      .tmit-onboard-card{width:calc(100vw - 32px);max-width:340px;}
      .tmit-help::after{width:min(220px, calc(100vw - 40px));}
    }
    /* Disable :hover-triggered transforms on touch-only devices \u2014 they
       otherwise stick after a tap and look like the FAB is permanently scaled. */
    @media (hover: none){
      #tmit-fab:hover{transform:none;box-shadow:0 0 14px rgba(151,2,173,0.5),0 4px 24px rgba(0,0,0,0.8);}
    }
  `);

  // ── API calls ─────────────────────────────────────────────────────────────────

  // v6.6.7 — Rate-limit cooldown. Torn allows 100 API calls/min PER KEY,
  // shared across every script using that key (TornTools, BSP, TECH, etc.).
  // When TEEM or another tool exhausts the quota the API returns
  // `{ error: { code: 5, error: "Too many requests" } }`. We catch that
  // in _gmFetch, set a 60s cooldown, and every TEEM call site
  // (poll, fetchAllItems, fetchLivePrices) checks isRateLimited() before
  // firing — so TEEM stops adding fuel to the fire while throttled.
  // Persisted to GM storage so a Torn page navigation mid-cooldown
  // doesn't reset the timer.
  const RATE_LIMIT_COOLDOWN_SEC = 60;
  let rateLimitedUntil = load('rateLimitedUntil', 0);
  function isRateLimited() {
    return rateLimitedUntil && Math.floor(Date.now() / 1000) < rateLimitedUntil;
  }
  function rateLimitRemainingSec() {
    if (!rateLimitedUntil) return 0;
    return Math.max(0, rateLimitedUntil - Math.floor(Date.now() / 1000));
  }
  function markRateLimited() {
    rateLimitedUntil = Math.floor(Date.now() / 1000) + RATE_LIMIT_COOLDOWN_SEC;
    store('rateLimitedUntil', rateLimitedUntil);
    try { setStatus('err', `Rate-limited · ${RATE_LIMIT_COOLDOWN_SEC}s`); } catch(e) {}
  }

  // ─── CROSS-TAB API CACHE (v6.7.1) ────────────────────────────────────
  // Tampermonkey runs a separate userscript instance per Torn tab. Without
  // a shared cache, each tab independently re-fetches the same endpoints,
  // multiplying the Torn API budget by the number of open tabs. With
  // poll-cycle work already taking 60s+ on a bloated install, multi-tab
  // amplification is what's pushing us into the 100/min rate limit.
  //
  // GM_setValue is shared across all tabs of the same userscript, so the
  // cache routes a freshness check through it: before fetching, check if
  // any tab cached this URL within the TTL window. If yes, return the
  // cached payload and skip the network call entirely.
  //
  // Cache key strips the api key (`key`), analytics comment (`comment`),
  // and any cache-buster (`_`) so identical "logical" calls from different
  // tabs share a key. Errors (anything with a `data.error` field, including
  // Torn's `error.code === 5` rate-limit) are NEVER cached — caching a
  // rate-limit response would propagate it to every tab for the full TTL.
  //
  // Hard eviction window is 24 h so long-TTL endpoints (catalog @ 6 h)
  // get full cross-tab dedup without unbounded blob growth.
  const XTCACHE_KEY              = 'xtcache';
  const XTCACHE_DEFAULT_TTL_MS   = 45000;
  const XTCACHE_HARD_EVICT_MS    = 24 * 60 * 60 * 1000;
  const XTCACHE_STRIP_PARAMS     = ['_', 'key', 'comment'];

  function xtCacheKey(url) {
    try {
      const u = new URL(url);
      for (const p of XTCACHE_STRIP_PARAMS) u.searchParams.delete(p);
      return u.origin + u.pathname + (u.search ? u.search : '');
    } catch (e) {
      return url;
    }
  }
  function xtCacheRead() { return load(XTCACHE_KEY, {}) || {}; }
  function xtCacheGet(key, ttl) {
    const all = xtCacheRead();
    const entry = all[key];
    if (!entry || typeof entry.ts !== 'number') return null;
    if ((Date.now() - entry.ts) > ttl) return null;
    return entry.data;
  }
  function xtCacheSet(key, data) {
    const all = xtCacheRead();
    all[key] = { ts: Date.now(), data: data };
    // Opportunistic eviction keeps the blob bounded across long sessions.
    const cutoff = Date.now() - XTCACHE_HARD_EVICT_MS;
    for (const k of Object.keys(all)) {
      if (!all[k] || typeof all[k].ts !== 'number' || all[k].ts < cutoff) delete all[k];
    }
    store(XTCACHE_KEY, all);
  }

  // apiGet with a custom timeout
  // Core HTTP helper — uses Promise.race to guarantee timeout fires
  // even if GM_xmlhttpRequest ignores the timeout field (some browsers/versions do)
  //
  // v6.7.1 — wraps the actual fetch with the cross-tab cache. Cache hits
  // resolve immediately with the previously-fetched payload; misses fall
  // through to the network. apiGet and apiGetWithTimeout both inherit the
  // dedup transparently because they call _gmFetch.
  function _gmFetchRaw(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:    'GET',
        url,
        timeout:   15000,
        onload:    (r) => {
          try {
            const data = JSON.parse(r.responseText);
            // v6.6.7 — peek at parsed payload for Torn's rate-limit code
            // BEFORE handing the data back. We still resolve normally so
            // existing call-site error handling (`data._error`, `data.error`)
            // keeps working; the side effect is that the cooldown timer
            // now reflects reality and downstream gates can short-circuit.
            if (data && data.error && data.error.code === 5) {
              markRateLimited();
            }
            resolve(data);
          }
          catch(e) { reject(new Error('JSON parse failed')); }
        },
        onerror:   () => reject(new Error('Network error')),
        ontimeout: () => reject(new Error('Request timed out')),
      });
    });
  }

  function _gmFetch(url, opts) {
    const ttl = (opts && typeof opts.crossTabTtl === 'number') ? opts.crossTabTtl : XTCACHE_DEFAULT_TTL_MS;
    const key = ttl > 0 ? xtCacheKey(url) : null;

    if (key) {
      const hit = xtCacheGet(key, ttl);
      if (hit !== null && hit !== undefined) return Promise.resolve(hit);
    }

    return _gmFetchRaw(url).then((data) => {
      // Don't cache error responses. A cached rate-limit (code 5) would
      // propagate the throttle to every tab for the full TTL — exactly
      // what we're trying to fix. Same logic for any other API error.
      const isError = data && (data.error || data._error);
      if (key && !isError) {
        try { xtCacheSet(key, data); } catch (e) { /* storage error — non-fatal */ }
      }
      return data;
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
    // v6.6.7 — skip the catalog fetch while throttled. fetchAllItems is
    // already TTL-cached (6h) so a skip almost always returns cached data
    // anyway; the only effect is we don't fire a doomed request.
    if (isRateLimited()) {
      if (lastMetadataFetch > 0) return {};
      throw new Error(`Rate-limited · retry in ${rateLimitRemainingSec()}s`);
    }
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
        throw new Error('Torn API unreachable \u2014 check your connection');
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
    // v6.6.7 — fetchLivePrices is the heaviest call site in TEEM (up to
    // MAX_LIVE_ITEMS=50 individual market lookups per poll). Bail early
    // when throttled so we don't deepen the cooldown. Also re-check
    // between batches in case the cooldown was set by another call
    // mid-loop (e.g. concurrent TornTools poll burning the same key).
    if (isRateLimited()) return {};
    const ids = buildPriorityList();
    if (!ids.length) return {};
    const live = {};
    const BATCH = 5;
    const deadline = Date.now() + 35000;
    for (let i = 0; i < ids.length; i += BATCH) {
      if (Date.now() > deadline) break;
      if (isRateLimited()) break;
      const batch = ids.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(id => fetchLivePrice(apiKey, id)));
      batch.forEach((id, j) => { if (results[j] > 0) live[id] = results[j]; });
      if (i + BATCH < ids.length) await new Promise(r => setTimeout(r, 150));
    }
    return live;
  }

  // ── Bazaar undercut fetch (v6.8.0) ─────────────────────────────────────────
  //
  // `/market/{id}?selections=bazaar` is a v1 endpoint (no v2 equivalent yet)
  // that returns an array of the cheapest player-Bazaar listings for an item.
  // Each listing has `cost` and `quantity`. Torn intentionally hides
  // player_id to discourage scraping individual stores — fine for our use
  // case (we only need "is there anything cheaper than Item Market?").
  //
  // The fetch is single-item-at-a-time like fetchLivePrice. We pick the
  // lowest cost across all listings as the headline Bazaar price.

  async function fetchBazaarPrice(apiKey, itemId) {
    try {
      const data = await apiGetWithTimeout(
        `https://api.torn.com/market/${itemId}?selections=bazaar&key=${apiKey}&comment=TEEM`,
        6000
      );
      if (!data || data._error || data.error) return null;
      const listings = Array.isArray(data.bazaar) ? data.bazaar : null;
      if (!listings || !listings.length) return null;
      let cheapest = null;
      for (const l of listings) {
        const cost = l && (l.cost ?? l.price);
        if (typeof cost !== 'number' || cost <= 0) continue;
        if (!cheapest || cost < cheapest.cost) {
          cheapest = { cost, quantity: l.quantity ?? l.amount ?? 0 };
        }
      }
      if (!cheapest) return null;
      return { ts: Date.now(), cost: cheapest.cost, quantity: cheapest.quantity };
    } catch (e) { return null; }
  }

  // Batched fetch — mirrors fetchLivePrices' 5-at-a-time + 150ms gap pattern
  // so a watchlist sweep (or "Scan all" click) doesn't slam the API. Honors
  // the rate-limit gate between batches.
  async function fetchBazaarBatch(apiKey, itemIds) {
    if (isRateLimited() || !apiKey || !itemIds?.length) return {};
    const result = {};
    const BATCH = 5;
    const deadline = Date.now() + 35000;
    for (let i = 0; i < itemIds.length; i += BATCH) {
      if (Date.now() > deadline) break;
      if (isRateLimited()) break;
      const batch = itemIds.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(id => fetchBazaarPrice(apiKey, id)));
      batch.forEach((id, j) => { if (results[j]) result[id] = results[j]; });
      if (i + BATCH < itemIds.length) await new Promise(r => setTimeout(r, 150));
    }
    return result;
  }

  function bazaarIsFresh(itemId) {
    const b = bazaarPrices[itemId];
    return !!b && (Date.now() - b.ts) < BAZAAR_TTL_MS;
  }

  // On-demand fetch triggered by the 💰 button. Three short-circuits:
  //   - cached fresh (< 30 min) → no API call, just rerender
  //   - already in-flight from a previous click → ignore
  //   - rate-limited → bail with notice
  async function fetchBazaarOnDemand(itemId, btnEl) {
    if (!settings.apiKey) { showTeemNotice('Add a Torn API key first', 'err'); return; }
    if (isRateLimited()) { showTeemNotice(`Rate-limited · retry in ${rateLimitRemainingSec()}s`, 'err'); return; }
    if (_bazaarInFlight.has(itemId)) return;
    if (bazaarIsFresh(itemId)) {
      showTeemNotice('Bazaar data still fresh (< 30 min old)');
      return;
    }
    _bazaarInFlight.add(itemId);
    let prevLabel;
    if (btnEl) { prevLabel = btnEl.textContent; btnEl.textContent = '…'; btnEl.style.opacity = '0.6'; }
    try {
      const result = await fetchBazaarPrice(settings.apiKey, itemId);
      if (result) {
        bazaarPrices[itemId] = result;
        saveBazaarPrices();
        showTeemNotice('Bazaar updated', 'ok');
        if (settings.activeTab === 'war') renderWarTab();
        else renderList();
      } else {
        showTeemNotice('No Bazaar listings found');
      }
    } finally {
      _bazaarInFlight.delete(itemId);
      if (btnEl) { btnEl.textContent = prevLabel ?? '💰'; btnEl.style.opacity = ''; }
    }
  }

  // Render helper — produces the inline pill HTML for a row when we have a
  // meaningful Bazaar undercut. Empty string when nothing to show, so callers
  // can splice it into the row template unconditionally.
  function buildBazaarPill(itemId, marketPrice, opts) {
    const b = bazaarPrices[itemId];
    if (!b || !b.cost || !(marketPrice > 0)) return '';
    const diffPct = ((b.cost - marketPrice) / marketPrice) * 100;
    if (diffPct > -BAZAAR_MIN_UNDERCUT_PCT) return ''; // no meaningful undercut
    const fmt = b.cost >= 1_000_000_000 ? `$${(b.cost / 1e9).toFixed(2)}B`
              : b.cost >= 1_000_000     ? `$${(b.cost / 1e6).toFixed(1)}M`
              : `$${b.cost.toLocaleString()}`;
    const ageMin = Math.floor((Date.now() - b.ts) / 60000);
    const ageTxt = ageMin < 1 ? 'just now' : ageMin + 'm ago';
    const qty = b.quantity ? ` · qty ${b.quantity}` : '';
    const cls = opts?.compact ? 'tmit-bazaar-pill compact' : 'tmit-bazaar-pill';
    return `<span class="${cls}" title="Bazaar undercut · ${ageTxt}${qty}">💰 ${fmt} (${diffPct.toFixed(0)}%)</span>`;
  }

  // ── Crime tracker ─────────────────────────────────────────────────────────
  //
  // Torn's `crimes` selection returns per-crime counters (attempts/successes).
  // `personalstats` returns lifetime money totals. The shape evolves over
  // time, so we snapshot the raw response and read defensively. Deltas
  // between consecutive snapshots over the last hour drive recommendations.
  //
  // What we store per snapshot:
  //   ts      — when we fetched it
  //   crimes  — the raw `crimes` field (cumulative counts per crime key)
  //   money   — total money earned via crime (from personalstats if present)

  function appendCrimeSnapshot(data) {
    if (!data) return;
    const ps = data.personalstats ?? {};
    const pc = ps.crimes;

    // v6.8.1 — Crimes 2.0 detection. Migrated personalstats shape:
    //   personalstats.crimes = {
    //     offenses: { theft, fraud, vandalism, ..., total },
    //     skills:   { shoplifting:0..100, pickpocketing:0..100, ... },
    //     total, version: "v2"
    //   }
    // Pre-migration accounts fall through to the legacy wildcard branch
    // below so old shapes keep working without surfacing the wrong shape.
    const isV2 = pc && typeof pc === 'object' && pc.version === 'v2'
      && pc.offenses && typeof pc.offenses === 'object';

    let merged = {};
    let skills = {};
    let totalCount = 0;
    let schema = 'v1';

    if (isV2) {
      schema = 'v2';
      for (const [k, v] of Object.entries(pc.offenses)) {
        if (k === 'total') continue;
        if (typeof v === 'number') merged[k] = v;
      }
      if (pc.skills && typeof pc.skills === 'object') {
        for (const [k, v] of Object.entries(pc.skills)) {
          if (typeof v === 'number') skills[k] = v;
        }
      }
      totalCount = typeof pc.total === 'number'
        ? pc.total
        : (typeof pc.offenses.total === 'number' ? pc.offenses.total : 0);
    } else {
      // Legacy v1 — keep old wildcard behavior. Stored in `merged` so
      // the downstream snap structure is identical regardless of schema.
      merged = {
        ...flattenCrimeCounts(data.crimes),
        ...flattenCrimeCounts(ps.crimes),
      };
      for (const [k, v] of Object.entries(ps)) {
        if (typeof v !== 'number') continue;
        const kl = k.toLowerCase();
        if (kl.startsWith('crim') || kl.endsWith('success') || kl.endsWith('fails')
            || kl === 'mugged' || kl === 'pickpocket' || kl === 'shoplift'
            || kl === 'thefts'  || kl === 'frauds'     || kl === 'autotheft'
            || kl === 'forgeries' || kl === 'hustling') {
          if (merged[k] === undefined) merged[k] = v;
        }
      }
      totalCount = merged.total ?? merged.criminaloffenses ?? 0;
    }

    // Money attribution. Crimes 2.0 doesn't expose per-category money in
    // personalstats.crimes anymore, but a legacy money_mugged etc. may
    // still appear on older accounts. We keep the field for compatibility
    // but the rebuilt Crimes tab no longer leans on the bogus per-attempt
    // share split — that produced wildly wrong $/hr numbers.
    const moneyFromCrime =
      (pc && typeof pc === 'object'
        ? (pc.money_mugged ?? pc.money_earned ?? 0)
        : 0)
      || ps.moneymugged
      || ps.money_mugged
      || ps.criminal_offenses_money
      || 0;

    const snap = {
      ts:        Date.now(),
      offenses:  merged,                // per-category attempts (v2) or legacy flat counts
      skills,                           // sub-crime skill levels 0..100 (v2 only, {} on v1)
      total:     totalCount,            // aggregate count from API
      money:     moneyFromCrime || null,
      schema,                           // 'v2' or 'v1'
      // Backwards-compat alias so old in-flight rows keep working.
      crimes:    merged,
    };

    // Diagnostic: log the shape when we find nothing useful, so the user
    // can share it back and we can patch the field names. Only logs once
    // per session (when bootstrapping) and again if we keep finding 0 keys.
    if (Object.keys(merged).length === 0) {
      const sample = {};
      if (data.crimes && typeof data.crimes === 'object') {
        sample['data.crimes keys']  = Object.keys(data.crimes).slice(0, 12);
      } else {
        sample['data.crimes']       = data.crimes;
      }
      if (ps.crimes && typeof ps.crimes === 'object') {
        sample['personalstats.crimes keys'] = Object.keys(ps.crimes).slice(0, 12);
      } else {
        sample['personalstats.crimes']      = ps.crimes;
      }
      sample['personalstats crime-ish keys'] = Object.keys(ps)
        .filter(k => /crim|theft|mugg|pickpocket|shoplift|fraud|forgery|hustl/i.test(k))
        .slice(0, 20);
      console.warn('[TEEM Crimes] No crime counts found \u2014 share this with TEEM:', sample);
    }

    crimeSnapshots.push(snap);
    if (crimeSnapshots.length > CRIME_SNAPSHOT_MAX) {
      crimeSnapshots = crimeSnapshots.slice(-CRIME_SNAPSHOT_MAX);
    }
    store('crimeSnapshots', crimeSnapshots);
  }

  // Crimes shape varies between API generations. Sometimes it's a flat
  // map of name→count; sometimes nested with {total, success}. Reduce to
  // a flat { crimeName: attempts } map so deltas are easy to compute.
  function flattenCrimeCounts(crimes) {
    if (!crimes || typeof crimes !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(crimes)) {
      if (typeof v === 'number') {
        out[k] = v;
      } else if (v && typeof v === 'object') {
        // Try common shape variants
        const n = v.total ?? v.attempts ?? v.count ?? v.success ?? null;
        if (typeof n === 'number') out[k] = n;
      }
    }
    return out;
  }

  // Pretty-print a Torn API crime key. Many `personalstats` keys are
  // smushed lowercase ("criminaloffenses") so the generic splitter alone
  // would produce "Criminaloffenses". Known keys win via the map; the rest
  // fall back to the snake_case/camelCase splitter.
  const CRIME_KEY_LABELS = {
    criminaloffenses:         'Criminal Offenses',
    criminal_offenses:        'Criminal Offenses',
    autotheft:                'Auto Theft',
    auto_theft:               'Auto Theft',
    drugdeals:                'Drug Deals',
    drugdealing:              'Drug Dealing',
    drug_dealing:             'Drug Dealing',
    selling_illegal_products: 'Selling Illegal Products',
    sellingillegalproducts:   'Selling Illegal Products',
    grandtheft:               'Grand Theft',
    grand_theft:              'Grand Theft',
    searchforcash:            'Search for Cash',
    search_for_cash:          'Search for Cash',
    pickpocket:               'Pickpocketing',
    pickpocketing:            'Pickpocketing',
    shoplift:                 'Shoplifting',
    shoplifting:              'Shoplifting',
    mugged:                   'Mugging',
    muggings:                 'Mugging',
    fraud:                    'Fraud',
    frauds:                   'Fraud',
    forgery:                  'Forgery',
    forgeries:                'Forgery',
    hustling:                 'Hustling',
    bootlegging:              'Bootlegging',
    graffiti:                 'Graffiti',
    counterfeiting:           'Counterfeiting',
    arson:                    'Arson',
    arsons:                   'Arson',
    cracking:                 'Cracking',
    scamming:                 'Scamming',
    burglary:                 'Burglary',
    burglaries:               'Burglary',
    disposal:                 'Disposal',
    computercrimes:           'Computer Crimes',
    computer_crimes:          'Computer Crimes',
    // ── Crimes 2.0 — top-level "offenses" categories (v6.8.1) ──
    vandalism:                'Vandalism',
    theft:                    'Theft',
    illicit_services:         'Illicit Services',
    cybercrime:               'Cybercrime',
    extortion:                'Extortion',
    illegal_production:       'Illegal Production',
    organized_crimes:         'Organized Crimes',
    // ── Crimes 2.0 — sub-crime "skills" ──
    card_skimming:            'Card Skimming',
    cardskimming:             'Card Skimming',
  };
  function prettifyCrimeKey(key) {
    const lc = String(key).toLowerCase();
    if (CRIME_KEY_LABELS[lc]) return CRIME_KEY_LABELS[lc];
    return String(key)
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // Compute rates from a window of recent snapshots.
  // Returns: { perCrime: [{name, attemptsPerHr, attempts, share}], totalAttemptsPerHr, moneyPerHr, windowHours }
  function computeCrimeRates() {
    if (crimeSnapshots.length < 2) return null;
    const now      = Date.now();
    const horizon  = now - 24 * 60 * 60 * 1000;
    const window   = crimeSnapshots.filter(s => s.ts >= horizon);
    if (window.length < 2) return null;

    const first = window[0];
    const last  = window[window.length - 1];
    const windowMs    = last.ts - first.ts;
    if (windowMs < 60 * 1000) return null;
    const windowHours = windowMs / 3_600_000;

    // Per-key rate calc. Use each key's earliest-and-latest snapshot where
    // it actually appears, not the global first/last — otherwise a key that
    // gets newly tracked mid-window produces a fake gigantic delta against
    // the implicit 0 baseline.
    //
    // v6.8.1 — prefer `s.offenses` (Crimes 2.0 categories) and fall back
    // to legacy `s.crimes` for snapshots taken before the v6.8.1 upgrade
    // (they age out of the 24h window naturally).
    const perCrime = [];
    let totalAttempts = 0;
    const crimeKeys = new Set();
    for (const s of window) {
      const src = s.offenses || s.crimes || {};
      for (const k of Object.keys(src)) crimeKeys.add(k);
    }

    for (const k of crimeKeys) {
      let firstVal = null, firstTs = 0, lastVal = null, lastTs = 0;
      for (const s of window) {
        const src = s.offenses || s.crimes || {};
        const v = src[k];
        if (typeof v !== 'number') continue;
        if (firstVal === null) { firstVal = v; firstTs = s.ts; }
        lastVal = v; lastTs = s.ts;
      }
      if (firstVal === null || lastVal === null) continue;
      const delta = Math.max(0, lastVal - firstVal);
      // Two distinct "no recent activity" cases we both want to keep
      // visible in the All Crimes list (just with attempts=0):
      //   1. Only one snapshot contains the key (lastTs === firstTs)
      //   2. Key appears in multiple snapshots but value never changed
      // Without keeping these, an active category that's idle for an hour
      // would silently vanish from the list. Only the "Top 3" sort cares
      // about recent attempts; the full list shows all-time too.
      const keyHours = (lastTs - firstTs) / 3_600_000;
      if (delta > 0 && keyHours > 0) totalAttempts += delta;
      perCrime.push({
        key:           k,
        name:          prettifyCrimeKey(k),
        attempts:      delta,
        attemptsPerHr: keyHours > 0 ? delta / keyHours : 0,
        totalAllTime:  lastVal,
        keyHours,
      });
    }
    // Sort by recent attempts desc, then by all-time desc as tiebreaker.
    perCrime.sort((a, b) =>
      (b.attempts - a.attempts) || (b.totalAllTime - a.totalAllTime)
    );
    for (const c of perCrime) c.share = totalAttempts > 0 ? c.attempts / totalAttempts : 0;

    // Latest skills snapshot (Crimes 2.0 only). Skills don't trend — they're
    // a 0..100 cap-tracking number — so we just surface the most recent
    // snapshot's values for the UI's "skill ladder" section.
    const latestSkills = (() => {
      for (let i = window.length - 1; i >= 0; i--) {
        if (window[i].skills && Object.keys(window[i].skills).length > 0) {
          return window[i].skills;
        }
      }
      return {};
    })();
    const schema = window[window.length - 1]?.schema || 'v1';

    // Money delta — find first/last snapshot that has a non-null money
    // total. Same defense against the v6.2.x parser-upgrade jump.
    let moneyFirst = null, moneyFirstTs = 0, moneyLast = null, moneyLastTs = 0;
    for (const s of window) {
      if (typeof s.money !== 'number' || s.money <= 0) continue;
      if (moneyFirst === null) { moneyFirst = s.money; moneyFirstTs = s.ts; }
      moneyLast = s.money; moneyLastTs = s.ts;
    }
    let moneyPerHr = null;
    if (moneyFirst !== null && moneyLast !== null && moneyLastTs > moneyFirstTs) {
      const moneyDelta = Math.max(0, moneyLast - moneyFirst);
      const moneyHours = (moneyLastTs - moneyFirstTs) / 3_600_000;
      if (moneyDelta > 0 && moneyHours > 0) moneyPerHr = Math.round(moneyDelta / moneyHours);
    }

    // v6.8.1 — dropped the per-attempt money-share split. Crimes 2.0
    // doesn't expose per-category money, so distributing the aggregate by
    // attempt share produced wildly wrong $/hr numbers (a maxed-out user
    // doing 60 cheap shoplifts/hr looked the same as one nailing 1 burglary
    // worth millions). The tab now leans on attempts + skill levels, and
    // shows the aggregate moneyPerHr only as a single sanity-check line.
    return {
      perCrime,
      totalAttempts,
      totalAttemptsPerHr: totalAttempts / windowHours,
      moneyPerHr,
      windowHours,
      sampleCount: window.length,
      skills: latestSkills,
      schema,
    };
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
    if (t === 'drug')                                                 return '\u211e';     // ℞ prescription
    if (t === 'medical')                                              return '\u271a';     // ✚ heavy cross
    if (t === 'plushie')                                              return '\u2665';     // ♥ heart
    if (t === 'flower')                                               return '\u273f';     // ✿ florette
    if (t === 'booster')                                              return '\u2605';     // ★ star
    if (t === 'energy drink')                                         return '\u26a1\ufe0e'; // ⚡ lightning (text)
    if (t === 'alcohol')                                              return '\u269c';     // ⚜ fleur-de-lis
    if (t === 'special')                                              return '\u2726';     // ✦ four-pointed star
    if (RW_ARMOR_TYPE_LOWER.has(t) || t === 'defensive')              return '\u26e8';     // ⛨ heraldic shield
    if (RW_WEAPON_TYPE_LOWER.has(t) || t === 'temporary')             return '\u2694\ufe0e'; // ⚔ crossed swords (text)
    return '$';
  }

  async function poll(force = false) {
    if (!settings.apiKey) return;
    // v6.6.7 — back off the entire poll cycle while throttled. pollTimer
    // keeps firing every settings.pollIntervalSec seconds, so we'll
    // automatically retry on the first tick after the cooldown elapses.
    if (isRateLimited()) {
      setStatus('err', `Rate-limited · retrying ${rateLimitRemainingSec()}s`);
      return;
    }
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
      if (!hasDisplayedData) setStatus('loading', 'Fetching\u2026');

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

      // Step 4b: Background Bazaar sweep (v6.8.0). Only watchlist items, only
      // every BAZAAR_POLL_EVERY-th cycle, capped at BAZAAR_WATCHLIST_CAP, and
      // skipped entirely if recently fetched (the 30-min TTL means a fresh
      // cache entry doesn't need refreshing). High-priced + War-Gear items
      // are user-triggered via the 💰 button to keep the background bill
      // close to zero — see fetchBazaarOnDemand.
      if (
        watchlist.size > 0 &&
        pollCounter % BAZAAR_POLL_EVERY === 0 &&
        !isRateLimited()
      ) {
        const stale = [...watchlist]
          .filter(id => Number.isFinite(id) && !bazaarIsFresh(id))
          .slice(0, BAZAAR_WATCHLIST_CAP);
        if (stale.length) {
          const fresh = await fetchBazaarBatch(settings.apiKey, stale);
          let touched = false;
          for (const [id, snap] of Object.entries(fresh)) {
            bazaarPrices[id] = snap;
            touched = true;
          }
          if (touched) saveBazaarPrices();
        }
      }

      // Also fetch YATA travel stock + foreign buy prices for the travel tab.
      // YATA shape (as of 2026-05): { stocks: { mex: { stocks: [ {id, quantity, cost}, ... ] }, ... } }
      // We populate two caches in parallel keyed by TEEM-internal country code:
      //   yataStockCache       -> raw available quantity per item
      //   yataTravelPriceCache -> current foreign buy cost per item (used for drugs)
      try {
        const travelData = await apiGet('https://yata.life/api/v1/travel/export/?format=json');
        const countries = travelData?.stocks;
        if (countries && !travelData.error) {
          const stockRes = {};
          const priceRes = {};
          for (const [yataCode, countryData] of Object.entries(countries)) {
            const teemCode = YATA_TO_TEEM[yataCode];
            if (!teemCode) continue;
            stockRes[teemCode] = {};
            priceRes[teemCode] = {};
            const items = Array.isArray(countryData?.stocks) ? countryData.stocks : [];
            for (const it of items) {
              if (typeof it?.id !== 'number') continue;
              if (typeof it.quantity === 'number') stockRes[teemCode][it.id] = it.quantity;
              if (typeof it.cost     === 'number') priceRes[teemCode][it.id] = it.cost;
            }
          }
          if (Object.keys(stockRes).length > 0) {
            yataStockCache = stockRes;
            yataTravelPriceCache = priceRes;
          }
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
      const srcLabel  = liveCount > 0 ? `\u26a1 ${liveCount} live` : '~ Avg';
      setStatus('ok', `${srcLabel} \u00b7 ${new Date().toLocaleTimeString()}`);

      // Fetch inventory + crime data in a single user/ call. Crimes throttled
      // to every 5 min so the response stays small most of the time.
      try {
        const wantCrimes = (Date.now() - lastCrimeFetch) > CRIME_FETCH_INTERVAL_MS;
        const sels = wantCrimes
          ? 'inventory,crimes,personalstats'
          : 'inventory';
        const inv = await apiGet(
          `https://api.torn.com/user/?selections=${sels}&key=${settings.apiKey}&comment=TEEM`
        );
        if (inv?.inventory) {
          userInventory = {};
          for (const [, item] of Object.entries(inv.inventory)) {
            const id = item.ID ?? item.id;
            if (id) userInventory[id] = { name: item.name ?? '', quantity: item.quantity ?? 1 };
          }
        }
        if (wantCrimes && !inv?.error) {
          appendCrimeSnapshot(inv);
          lastCrimeFetch = Date.now();
          const panelEl2 = document.getElementById('tmit-panel');
          if (panelEl2 && !panelEl2.classList.contains('tmit-hidden')
              && settings.activeTab === 'crimes') {
            try { renderCrimesTab(); } catch(e) {}
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
        console.warn(`[TEEM poll] ${Math.round(totalDur)}ms total \u2014 ${parts.join(', ')}`);
      }
    } catch(e) { setStatus('err', e.message.slice(0, 50)); }
  }

  async function pollStats() {
    if (!settings.apiKey) return;
    // v6.6.7 — skip the stats poll while throttled (battlestats is also
    // a metered Torn API call). Silent failure is the existing pattern
    // here so we just return.
    if (isRateLimited()) return;
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
    const marketMs = Math.max(60, settings.marketPollSec ?? 180) * 1000;
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
    // NOTE: position (bottom/right) is intentionally NOT inline so the
    // @media(max-width:768px) rule can override it on mobile. Otherwise
    // an inline `bottom:28px` wins specificity-wise over the @media rule,
    // and on Firefox Android the URL bar (which lives at the bottom of
    // the viewport) hides the FAB. The base GM_addStyle rule sets the
    // desktop position; the @media rule lifts it on narrow viewports.
    fab.style.cssText = 'position:fixed;width:84px;height:84px;'
      + 'border-radius:14px;background:#000;'
      + 'border:2px solid #c9a227;cursor:pointer;'
      + 'z-index:2147483000;box-shadow:0 0 14px rgba(151,2,173,0.6),'
      + '0 4px 24px rgba(0,0,0,0.8);';
    // Full logo PNG (elephant + baked-in "TEEM" wordmark) shown via
    // background-image on a div, so host-page img rules can't squash it.
    // No clipping, no overlay — just the image scaled to fit.
    fab.innerHTML = `<div class="tmit-fab-elephant" style="background-image:url('${TEEM_ELEPHANT_DATAURL}');"></div><div class="tmit-alert-badge" id="tmit-alert-badge">$</div>`;
    fab.title = "TEEM \u2014 Torn's Elephant Economy Manager";
    // Restore the compact-size choice before append so the first paint
    // already has the right dimensions (no flash-of-large-FAB on reload).
    if (settings.fabSize === 'small') fab.classList.add('tmit-fab-small');
    document.body.appendChild(fab);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'tmit-panel';
    panel.classList.add('tmit-hidden');
    panel.innerHTML = `
      <div class="tmit-header" id="tmit-drag-handle">
        <div class="tmit-title">
          <div style="width:28px;height:28px;flex-shrink:0;background:url('${TEEM_ELEPHANT_DATAURL}') center / contain no-repeat;"></div>
          Elephant Economy Manager
          <small class="tmit-version">v${SCRIPT_VERSION}</small>
        </div>
        <div class="tmit-header-right">
          <span class="tmit-status-pill" id="tmit-status">Loading\u2026</span>
          <button class="tmit-btn-refresh" id="tmit-btn-refresh" title="Refresh now">\u21bb</button>
          <button class="tmit-btn-settings-toggle" id="tmit-btn-settings-toggle" title="Settings">\u2699</button>
          <button class="tmit-btn-close" id="tmit-btn-close" title="Close">\u2715</button>
        </div>
      </div>

      <div class="tmit-session-bar" id="tmit-session-bar">
        <div class="tmit-session-item">\ud83d\udce6 Inventory: <span class="tmit-session-val" id="tmit-sess-inv">\u2014</span></div>
        <div class="tmit-session-item">\ud83d\udcb0 Session: <span class="tmit-session-val positive" id="tmit-sess-profit">$0</span></div>
        <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
          <span id="tmit-age-dot" class="tmit-age-dot tmit-age-fresh"></span>
          <span id="tmit-age-text" style="color:#9886b8;font-size:9px">\u2014</span>
          <button class="tmit-btn-export" id="tmit-btn-export" title="Export current view to CSV">\u2b07 CSV</button>
        </div>
      </div>

      <div class="tmit-tab-bar">
        <div class="tmit-tab tmit-tab-active" data-tab="all">Market</div>
        <div class="tmit-tab" data-tab="watchlist">\u2b50 Watch <span class="tmit-tab-count" id="tmit-watch-count">0</span></div>
        <div class="tmit-tab" data-tab="war">\u2694 War Gear</div>
        <div class="tmit-tab" data-tab="travel">\u2708 Travel</div>
        <div class="tmit-tab" data-tab="crimes">\ud83c\udfaf Crimes</div>
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
        <input type="text" class="tmit-search" id="tmit-search" placeholder="Search items\u2026">
      </div>

      <div class="tmit-filter-row">
        <span class="tmit-filter-label">Budget</span>
        <input type="number" class="tmit-input-sm" id="tmit-budget-input"
          placeholder="Max price\u2026" value="${settings.maxBudget || ''}">
        <div class="tmit-divider"></div>
        <span class="tmit-filter-label">Min \u0394%</span>
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
          <div class="tmit-state-icon">\ud83d\udc8e</div>
          ${settings.apiKey ? 'Fetching market data\u2026' : 'Open \u2699 settings and enter your Torn API key.'}
        </div>
      </div>

      <!-- War Gear Tab -->
      <div id="tmit-war-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
          <div class="tmit-section-title" style="margin:0;padding:0;border:none;">\u2694 War Gear Price Tracker</div>
          <button id="tmit-bazaar-scan-war" class="tmit-bazaar-scan-btn"
            title="Fetch Bazaar prices for every War Gear item (one burst, ~30-90 API calls). Each lookup cached 30 min so re-clicks are free.">
            \ud83d\udcb0 Scan all
          </button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 80px 80px 70px 55px;padding:4px 8px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.12);border-radius:4px 4px 0 0;margin-bottom:1px;">
          <div class="tmit-col-hdr">Item Name</div>
          <div class="tmit-col-hdr" style="text-align:right">Price</div>
          <div class="tmit-col-hdr" style="text-align:right">BB Value</div>
          <div class="tmit-col-hdr" style="text-align:right">$ equiv</div>
          <div class="tmit-col-hdr" style="text-align:right">\u0394%</div>
        </div>
        <div id="tmit-war-tracker-list" class="tmit-war-tracker">
          <div class="tmit-state-msg" style="padding:16px 0;">
            <div class="tmit-state-icon" style="font-size:20px">\u2694</div>
            War gear prices appear here once the market poll detects weapon/armor items.
          </div>
        </div>
      </div>

      <!-- Travel Tab -->
      <div id="tmit-travel-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">\u2708 Travel Profit Rankings</div>

        <!-- Flight type + carry capacity -->
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:6px;padding:7px 9px;background:rgba(0,0,0,0.25);border-radius:6px;border:1px solid rgba(201,162,39,0.1);">
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="font-size:9px;color:#a294c0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Flight</span>
            <select id="tmit-flight-type" class="tmit-select" style="font-size:10px;">
              <option value="economy"  ${settings.flightType==='economy'  ?'selected':''}>\u2708 Economy</option>
              <option value="airstrip" ${settings.flightType==='airstrip' ?'selected':''}>\ud83d\udeeb Airstrip (\u221230%)</option>
              <option value="business" ${settings.flightType==='business' ?'selected':''}>\ud83d\udcba Business (\u221250%)</option>
              <option value="wlt"      ${settings.flightType==='wlt'      ?'selected':''}>\ud83c\udf1f WLT (\u221250%)</option>
            </select>
          </div>
          <div style="display:flex;align-items:center;gap:5px;">
            <span style="font-size:9px;color:#a294c0;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;">Carry</span>
            <input type="number" id="tmit-travel-capacity" class="tmit-input-sm"
              value="${settings.carryCapacity || 10}" min="1" max="100" style="width:52px;font-size:11px;">
            <span style="font-size:9px;color:#a08fc0;">items</span>
          </div>
          <button class="tmit-btn-calc" style="margin:0;margin-left:auto;padding:4px 10px;font-size:10px;" id="tmit-travel-refresh">\u21bb</button>
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
            <div class="tmit-state-icon">\u2708</div>
            Travel data loads with the next market poll.
          </div>
        </div>

        <div class="tmit-section-title" style="margin-top:14px;">\ud83d\udccb Trip Details</div>
        <div id="tmit-travel-detail" style="font-size:11px;color:#ab9bce;padding:6px 0;">
          Click a destination above to see trip details.
        </div>
      </div>

      <!-- Crimes Tab -->
      <div id="tmit-crimes-panel" class="tmit-tab-panel" style="display:none;flex:1;overflow-y:auto;padding:12px;">
        <div class="tmit-section-title">\ud83c\udfaf Crime Tracker</div>
        <div style="font-size:10px;color:#a08fc0;margin-bottom:8px;line-height:1.6;">
          Tracks your personal crime activity. Money/hour is your real measured rate
          based on snapshots since you installed \u2014 TEEM needs ~1 hour of play to give
          meaningful numbers.
        </div>

        <div id="tmit-crime-best" style="margin-bottom:12px;"></div>
        <div class="tmit-section-title" style="margin-top:14px;">All Crimes (last 24h)</div>
        <div id="tmit-crime-list">
          <div class="tmit-state-msg" style="padding:18px 0;">
            <div class="tmit-state-icon">\ud83c\udfaf</div>
            Collecting crime data \u2014 first sample appears within 5 minutes,
            ranking becomes meaningful after ~1 hour of play.
          </div>
        </div>
      </div>

      <div class="tmit-settings-panel" id="tmit-settings-panel">
        <div class="tmit-settings-title">\u2699 Settings</div>

        <div style="font-size:10px;color:#a08fc0;line-height:1.6;margin-bottom:10px;padding:6px 8px;background:rgba(201,162,39,0.05);border:1px solid rgba(201,162,39,0.12);border-radius:5px;">
          All keys are stored locally on your device only \u2014 never sent anywhere except directly to that service's own API.
          <b style="color:#c9a227">Create a separate key per service</b> so you can revoke them individually if needed.
        </div>

        <!-- TORN MARKET API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          Torn Market API Key <span style="color:#ff6060;font-weight:400;">\u2605 Required</span>
        </div>
        <div style="font-size:9px;color:#a08fc0;margin-bottom:5px;line-height:1.5;">
          Used for live item prices, your stats, and carry-capacity detection.
          Get yours at <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">torn.com \u2192 Preferences \u2192 API \u2197</a>
          \u2014 a <b style="color:#e8dff5">Limited</b> key is enough.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-apikey-input" placeholder="Paste Torn API key here\u2026"
            value="${settings.apiKey}" autocomplete="off"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-apikey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#a294c0;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">\ud83d\udc41</button>
        </div>
        <div id="tmit-apikey-status" style="font-size:10px;min-height:14px;margin-bottom:8px;padding-left:2px;"></div>


        <!-- YATA API KEY -->
        <div style="font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#c9a227;margin-bottom:4px;">
          YATA API Key <span style="color:#a294c0;font-weight:400;">Optional</span>
        </div>
        <div style="font-size:9px;color:#a08fc0;margin-bottom:5px;line-height:1.5;">
          Unlocks <b style="color:#e8dff5">YATA spy data</b> for player overlays and more accurate travel stock estimates.
          Log in at <a href="https://yata.life" target="_blank" rel="noopener"
            style="color:#c9a227;text-decoration:none;">yata.life \u2197</a>
          with your Torn account \u2014 your YATA key is in your profile settings there.
        </div>
        <div style="display:flex;gap:4px;margin-bottom:3px;">
          <input type="password" id="tmit-yata-key-input" placeholder="Paste YATA key here\u2026" autocomplete="off" value="${load('yataKey', '')}"
            style="flex:1;background:rgba(0,0,0,0.5);border:1px solid rgba(201,162,39,0.25);border-radius:4px;color:#e8dff5;font-size:12px;padding:6px 9px;outline:none;font-family:monospace;">
          <button id="tmit-yatakey-toggle" title="Show/hide key"
            style="background:none;border:1px solid rgba(201,162,39,0.2);color:#a294c0;border-radius:4px;padding:4px 8px;cursor:pointer;font-size:12px;flex-shrink:0;">\ud83d\udc41</button>
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

        <button class="tmit-btn-save" id="tmit-btn-save" style="width:100%;">\ud83d\udcbe Save All Settings</button>
      </div>

      <div class="tmit-footer">
        <span class="tmit-footer-stat">Items tracked: <span id="tmit-item-count">0</span></span>
        <span class="tmit-footer-stat">Snapshots: <span id="tmit-snapshot-count">0</span></span>
        <span class="tmit-footer-stat">Next poll: <span id="tmit-next-poll">\u2014</span></span>
      </div>
    `;
    document.body.appendChild(panel);

    bindEvents(fab, panel);
    updateFooter();
    // footerTimer is started by resumeBackgroundWork() when the panel opens

    // Restore FAB position. We always apply saved fabX/fabY when present and
    // let clampFabPos rescue off-screen coords — this is the v6.5.6 behaviour
    // before the (overzealous) narrow-viewport skip that hid FF Android
    // installs whose only-visible position came from a previous mobile drag.
    if (settings.fabX !== null) {
      fab.style.right  = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left   = settings.fabX + 'px';
      fab.style.top    = settings.fabY + 'px';
      clampFabPos(fab, true);
    }

    // Panel starts hidden — position is set when it opens (see openPanel())
  }

  // ── Onboarding ────────────────────────────────────────────────────────────

  function buildOnboarding() {
    const el = document.createElement('div');
    el.id = 'tmit-onboard';
    el.innerHTML = `
      <div class="tmit-onboard-card">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
          <div class="tmit-onboard-logo" style="width:36px;height:36px;margin:0;flex-shrink:0;background-image:url('${TEEM_ELEPHANT_DATAURL}');"></div>
          <div>
            <div class="tmit-onboard-title" style="font-size:13px;text-align:left;margin:0;">Welcome to TEEM</div>
            <div class="tmit-onboard-subtitle" style="text-align:left;margin:0;font-size:10px;">Let's get you set up \u2014 Torn stays usable the whole time</div>
          </div>
          <button id="tmit-ob-close-x" style="margin-left:auto;background:none;border:none;color:#9886b8;font-size:16px;cursor:pointer;padding:0;line-height:1;" title="Close (set up later via \u2699 in the panel)">\u2715</button>
        </div>

        <!-- Step 1: API Key -->
        <div class="tmit-onboard-step active" id="tmit-ob-step-1">
          <div class="tmit-onboard-step-title">Step 1 of 4 \u2014 Connect to Torn</div>
          <div class="tmit-onboard-step-body">
            TEEM needs a <b>Torn API key</b> to fetch live market prices and your carry capacity.<br><br>
            A <b>Limited</b> key is enough - just enable <code>Market</code>, <code>User</code>, and <code>Torn</code> access when creating it.
          </div>
          <a href="https://www.torn.com/preferences.php#tab=api" target="_blank" rel="noopener"
            style="display:inline-flex;align-items:center;gap:6px;margin-bottom:10px;padding:7px 14px;background:rgba(201,162,39,0.12);border:1px solid rgba(201,162,39,0.3);border-radius:6px;color:#ffe066;font-size:11px;font-weight:700;text-decoration:none;transition:background 0.15s;"
            onmouseover="this.style.background='rgba(201,162,39,0.22)'"
            onmouseout="this.style.background='rgba(201,162,39,0.12)'">
            \ud83d\udd11 Open Torn API Settings (new tab) \u2197
          </a>
          <div style="font-size:10px;color:#a08fc0;margin-bottom:8px;">
            Come back here and paste your key below once you've created it \u2014 this window stays open.
          </div>
          <input type="password" class="tmit-onboard-input" id="tmit-ob-apikey" placeholder="Paste your API key here\u2026" autocomplete="off">
          <div class="tmit-onboard-validate" id="tmit-ob-validate"></div>
        </div>

        <!-- Step 2: Carry capacity -->
        <div class="tmit-onboard-step" id="tmit-ob-step-2">
          <div class="tmit-onboard-step-title">Step 2 of 4 \u2014 Your Carry Capacity</div>
          <div class="tmit-onboard-step-body">
            How many items can you carry per trip? Check your <b>Travel page in-game</b> for the exact number.<br><br>
            Common sources of capacity: base (5) + suitcase (+2/+4) + faction Excursion (+1\u201310) + property airstrip (+10) + job specials (+2\u20135).
          </div>
          <div class="tmit-onboard-capacity-row" style="align-items:flex-start;flex-direction:column;gap:8px;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="tmit-onboard-cap-val" id="tmit-ob-cap-val">\u2014</div>
              <div class="tmit-onboard-cap-detail" id="tmit-ob-cap-detail">Detecting from API\u2026</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;width:100%;">
              <label style="font-size:11px;color:#a294c0;white-space:nowrap;">Adjust if wrong:</label>
              <input type="number" id="tmit-ob-cap-input" min="1" max="100"
                style="width:70px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.3);border-radius:5px;color:#ffe066;font-family:monospace;font-size:16px;font-weight:700;padding:4px 8px;outline:none;text-align:center;"
                placeholder="29">
              <span style="font-size:10px;color:#a08fc0;">items per trip</span>
            </div>
            <div style="font-size:10px;color:#a08fc0;">You can always change this in the \u2708 Travel tab.</div>
          </div>
        </div>

        <!-- Step 3: Tab tour -->
        <div class="tmit-onboard-step" id="tmit-ob-step-3">
          <div class="tmit-onboard-step-title">Step 3 of 4 \u2014 What's Inside</div>
          <div class="tmit-onboard-tab-grid">
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">\ud83d\udcc8</div>
              <div class="tab-name">Market</div>
              <div class="tab-desc">Tracks all item prices. Hot/cold signals show what's rising or falling.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">\u2b50</div>
              <div class="tab-name">Watchlist</div>
              <div class="tab-desc">Pin items to watch. Click any WATCH badge to add it here.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">\u2708</div>
              <div class="tab-name">Travel</div>
              <div class="tab-desc">Ranks all 11 destinations by profit/hr. Click any for full trip details.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">\u2694</div>
              <div class="tab-name">War Gear</div>
              <div class="tab-desc">Live market prices for ranked war weapons & armor, with BB trade-in values.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">\ud83c\udfaf</div>
              <div class="tab-name">Crimes</div>
              <div class="tab-desc">Tracks your personal crime activity; ranks your top 3 by measured $/hour.</div>
            </div>
            <div class="tmit-onboard-tab-card">
              <div class="tab-icon">\ud83d\udcb0</div>
              <div class="tab-name">Session Bar</div>
              <div class="tab-desc">Live inventory estimate and session profit tracked at the top.</div>
            </div>
          </div>
        </div>

        <!-- Step 4: You're ready -->
        <div class="tmit-onboard-step" id="tmit-ob-step-4">
          <div class="tmit-onboard-step-title">Step 4 of 4 \u2014 You're Ready \ud83d\udc18</div>
          <div class="tmit-onboard-step-body">
            TEEM is now running. A few tips:<br><br>
            \u2022 <b>Drag</b> the \ud83d\udc18 TEEM button anywhere on screen<br>
            \u2022 <b>Alt+T</b> toggles the panel from anywhere in Torn<br>
            \u2022 Data builds over time \u2014 signals get smarter the longer it runs<br>
            \u2022 <b>Prices update every minute</b> using live Torn API data<br><br>
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
            <button class="tmit-onboard-btn" id="tmit-ob-next" disabled>Next \u2192</button>
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
      nextBtn.textContent = n === totalSteps ? 'Start TEEM \u2192' : 'Next \u2192';
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
        validateEl.textContent = 'Checking key\u2026';
        try {
          const data = await apiGet(
            `https://api.torn.com/user/?selections=basic&key=${val}&comment=TEEM`
          );
          if (data.error) {
            validateEl.className = 'tmit-onboard-validate err';
            validateEl.textContent = `\u2717 ${data.error.error}`;
          } else {
            validateEl.className = 'tmit-onboard-validate ok';
            validateEl.textContent = `\u2713 Connected as ${data.name}`;
            validatedKey = val;
            nextBtn.disabled = false;
          }
        } catch(e) {
          validateEl.className = 'tmit-onboard-validate err';
          validateEl.textContent = `\u2717 ${e.message}`;
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
        capVal.textContent = '\u2026';
        capDetail.textContent = 'Checking API\u2026';
        const cap = await detectCarryCapacity(validatedKey);
        detectedCapacity = cap ?? 10;
        capVal.textContent = detectedCapacity;
        capInput.value = detectedCapacity;
        const isGuess = !cap || cap === 10;
        capDetail.textContent = isGuess
          ? '\u26a0 Could not auto-detect \u2014 please enter your actual number above'
          : '\u2713 Detected from your API data \u2014 adjust if needed';
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

    // On narrow viewports (PDA / phones / small browser windows) ignore any
    // saved desktop position and let the @media (max-width:768px) CSS pin
    // the panel near-fullscreen. Otherwise a position saved on desktop would
    // push the panel off-screen on mobile.
    const isNarrow = window.innerWidth <= 768;
    if (isNarrow) {
      panel.style.right  = '';
      panel.style.bottom = '';
      panel.style.left   = '';
      panel.style.top    = '8px';
    } else if (settings.posX !== null) {
      // Desktop: restore the previously saved position
      panel.style.right  = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left   = settings.posX + 'px';
      panel.style.top    = settings.posY + 'px';
      // Rescue stuck positions: a posX/posY saved on a larger viewport (or a
      // monitor that's since been disconnected) could place the panel mostly
      // off-screen on this one. Clamp back inside before the user sees it.
      clampPanelPos(panel, true);
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
    // FAB — single click toggles panel, drag repositions. On desktop ONLY,
    // a second click within 220ms toggles the FAB between full and compact
    // size instead of the panel.
    let fabDragging = false;
    let fabStartX = 0, fabStartY = 0, fabOx = 0, fabOy = 0;
    let fabTapTimer = null;

    // Mobile gets immediate panel-toggle on tap, no size gesture. The
    // v6.6.0 tap-debounce was a tester-requested feature but Firefox
    // Android fires duplicate pointerdowns for a single touch (touch →
    // compat-mouse), which made the double-tap detector fire on every
    // single tap — the FAB ping-ponged between sizes until it was
    // invisible. Sticking the debounce behind `(hover: hover)` matches
    // it to true mouse-capable devices only.
    const supportsHover = window.matchMedia?.('(hover: hover)').matches ?? true;

    const togglePanel = () => {
      if (panel.classList.contains('tmit-hidden')) {
        openPanel(fab, panel);
      } else {
        panel.classList.add('tmit-hidden');
        suspendBackgroundWork();
      }
    };

    // Pointer events unify mouse + touch + pen so this works on desktop
    // browsers AND inside the Torn PDA WebView with no platform branching.
    fab.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      fabDragging = false;
      fabStartX = e.clientX;
      fabStartY = e.clientY;
      const rect = fab.getBoundingClientRect();
      fabOx = rect.left;
      fabOy = rect.top;
      const fabW = rect.width  || 84;
      const fabH = rect.height || 84;

      const onMove = (e) => {
        const dx = e.clientX - fabStartX;
        const dy = e.clientY - fabStartY;
        if (Math.sqrt(dx*dx + dy*dy) > 5) {
          fabDragging = true;
          fab.style.right  = 'auto';
          fab.style.bottom = 'auto';
          fab.style.left   = Math.max(0, Math.min(window.innerWidth  - fabW, fabOx + dx)) + 'px';
          fab.style.top    = Math.max(0, Math.min(window.innerHeight - fabH, fabOy + dy)) + 'px';
        }
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup',   onUp);
        document.removeEventListener('pointercancel', onUp);
        if (fabDragging) {
          settings.fabX = parseInt(fab.style.left);
          settings.fabY = parseInt(fab.style.top);
          settings.posX = null; settings.posY = null;
          saveSettings();
        } else if (!supportsHover) {
          // Touch-only device — immediate panel toggle, no size gesture.
          togglePanel();
        } else if (fabTapTimer) {
          // Desktop: second click within 220ms — treat as double-click and
          // toggle the FAB size instead of the panel.
          clearTimeout(fabTapTimer);
          fabTapTimer = null;
          toggleFabSize(fab);
        } else {
          // Desktop first click — defer the panel toggle by 220ms so a
          // follow-up click can upgrade the gesture to a double-click.
          // 220ms feels instant enough that users don't notice; longer
          // delays start to feel sluggish.
          fabTapTimer = setTimeout(() => {
            fabTapTimer = null;
            togglePanel();
          }, 220);
        }
        fabDragging = false;
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup',   onUp);
      document.addEventListener('pointercancel', onUp);
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
      e.target.textContent = inp.type === 'password' ? '\ud83d\udc41' : '\ud83d\ude48';
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
      const key     = panel.querySelector('#tmit-apikey-input')?.value.trim()    || '';
      const yataKey = panel.querySelector('#tmit-yata-key-input')?.value.trim() || '';

      if (key)     settings.apiKey = key;
      if (yataKey) store('yataKey', yataKey);
      saveSettings();

      // Feedback
      const saved = [key && 'Torn', yataKey && 'YATA'].filter(Boolean);
      if (saved.length) {
        const statusEl = document.getElementById('tmit-apikey-status');
        if (statusEl) {
          statusEl.textContent = '\u2713 ' + saved.join(', ') + ' key' + (saved.length > 1 ? 's' : '') + ' saved';
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
        openItemMarket(parseInt(buyBtn.dataset.id), buyBtn.dataset.name, buyBtn.dataset.cat);
      }
      if (sellBtn) {
        // Soft guard: warn if user doesn't appear to own the item, then
        // just navigate to Items so they (or TornTools' Quick Sell) can
        // list it. We don't try to auto-fill anymore — Torn's React market
        // page has hashed class names that break fragile injection.
        const id    = parseInt(sellBtn.dataset.id);
        const owned = userInventory[id]?.quantity ?? 0;
        const name  = sellBtn.dataset.name;
        if (!owned) showTeemNotice(`No ${name} in your last inventory snapshot \u2014 opening Items page anyway`);
        if (!window.location.href.includes('item.php')) {
          window.location.href = 'https://www.torn.com/item.php';
        }
      }
    });

    // Bazaar on-demand buttons (Market + War Gear rows) and the "Scan all"
    // button at the top of the War Gear tab. All three go through
    // fetchBazaarOnDemand / fetchBazaarBatch, which respect the 30-min
    // cache + the existing rate-limit gate.
    panel.addEventListener('click', async (e) => {
      const bazBtn = e.target.closest('.tmit-bazaar-btn, .tmit-war-bazaar-btn');
      if (bazBtn) {
        e.stopPropagation();
        const id = parseInt(bazBtn.dataset.id);
        if (Number.isFinite(id)) fetchBazaarOnDemand(id, bazBtn);
        return;
      }
      const scanBtn = e.target.closest('#tmit-bazaar-scan-war');
      if (scanBtn) {
        if (!settings.apiKey) { showTeemNotice('Add a Torn API key first', 'err'); return; }
        if (isRateLimited())  { showTeemNotice(`Rate-limited · retry in ${rateLimitRemainingSec()}s`, 'err'); return; }
        const ids = Object.keys(itemMeta)
          .filter(k => !String(k).startsWith('rw_'))
          .map(k => parseInt(k))
          .filter(id => {
            const m = itemMeta[id];
            return m && isRWItem(m.name, m.type) && !bazaarIsFresh(id);
          });
        if (!ids.length) {
          showTeemNotice('All War Gear Bazaar data already fresh (< 30 min)', 'ok');
          return;
        }
        scanBtn.disabled = true;
        const prev = scanBtn.textContent;
        scanBtn.textContent = `💰 Scanning ${ids.length}…`;
        try {
          const fresh = await fetchBazaarBatch(settings.apiKey, ids);
          const count = Object.keys(fresh).length;
          Object.assign(bazaarPrices, fresh);
          if (count) saveBazaarPrices();
          showTeemNotice(`Bazaar scan complete · ${count} updates`, count ? 'ok' : null);
          if (settings.activeTab === 'war') renderWarTab();
        } finally {
          scanBtn.disabled = false;
          scanBtn.textContent = prev;
        }
      }
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
      const badge = e.target.closest('.tmit-signal-badge');
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
    const crimePanel  = document.getElementById('tmit-crimes-panel');

    // Defensive: any old setting that still says 'quick' or 'arb' (now-
    // removed tabs) bumps back to the Market tab.
    if (tab === 'quick' || tab === 'arb') { tab = 'all'; settings.activeTab = 'all'; saveSettings(); }

    const isMarket = tab === 'all' || tab === 'watchlist';
    if (controls)     controls.style.display    = isMarket ? '' : 'none';
    if (filterRow)    filterRow.style.display   = isMarket ? '' : 'none';
    if (colHeaders)   colHeaders.style.display  = isMarket ? '' : 'none';
    if (listEl)       listEl.style.display      = isMarket ? '' : 'none';
    if (warPanel)     warPanel.style.display    = tab === 'war'    ? 'flex' : 'none';
    if (travelPanel)  travelPanel.style.display = tab === 'travel' ? 'flex' : 'none';
    if (crimePanel)   crimePanel.style.display  = tab === 'crimes' ? 'flex' : 'none';

    // Update active tab highlight
    document.querySelectorAll('.tmit-tab').forEach(t =>
      t.classList.toggle('tmit-tab-active', t.dataset.tab === tab)
    );

    if (isMarket)              renderList();
    else if (tab === 'war')    renderWarTab();
    else if (tab === 'travel') renderTravelTab();
    else if (tab === 'crimes') renderCrimesTab();
  }

  // ── Travel Tab ────────────────────────────────────────────────────────────

  function renderTravelTab() {
    const listEl = document.getElementById('tmit-travel-list');
    if (!listEl) return;

    if (!travelRanking.length) {
      listEl.innerHTML = `<div class="tmit-state-msg">
        <div class="tmit-state-icon">\u2708</div>
        Waiting for market data. Hit \u21bb to force a refresh.
      </div>`;
      return;
    }

    const carry = settings.carryCapacity || 10;
    const rows = travelRanking.map((r, i) => {
      const rankClass = i === 0 ? 'rank1' : i === 1 ? 'rank2' : i === 2 ? 'rank3' : '';
      const pphClass  = i === 0 ? 'tmit-travel-pph top' : 'tmit-travel-pph';
      const stockConf = r.bestItem?.stockConf ?? 'assumed';
      const stockQty  = r.bestItem?.stockQty;
      let stockTxt;
      if (stockConf !== 'yata' || typeof stockQty !== 'number') {
        stockTxt = '~stock';
      } else if (stockQty === 0) {
        stockTxt = 'EMPTY';
      } else if (stockQty < carry) {
        stockTxt = `${stockQty} only`;
      } else {
        stockTxt = `${stockQty} \u2713`;
      }

      return `<div class="tmit-travel-row ${rankClass}" data-code="${r.code}">
        <div class="tmit-travel-flag">${r.flagEmoji}</div>
        <div>
          <div class="tmit-travel-dest">${r.country}</div>
          <div class="tmit-travel-sub">${r.bestItem?.itemName ?? '\u2014'}</div>
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
          <div class="tmit-result-row"><span class="tmit-result-label">Best Item</span><span class="tmit-result-val">${item?.itemName ?? '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Buy Price (abroad)</span><span class="tmit-result-val icy">$${item?.buyPrice?.toLocaleString() ?? '\u2014'} <span style="font-size:9px;color:${item?.priceSource === 'yata' ? '#50dc82' : '#c9a227'};">${item?.priceSource === 'yata' ? '(YATA live)' : '(vendor)'}</span></span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Market Price</span><span class="tmit-result-val hot">$${item?.sellPrice?.toLocaleString() ?? '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">After 5% Tax</span><span class="tmit-result-val hot">$${item?.netSellPrice?.toLocaleString() ?? '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Profit / Item</span><span class="tmit-result-val green">$${item?.profitPerItem?.toLocaleString() ?? '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Carry (effective)</span><span class="tmit-result-val">${item?.actualCap ?? '\u2014'} items</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Revenue / Trip</span><span class="tmit-result-val">$${item ? Math.round(item.netSellPrice * item.actualCap).toLocaleString() : '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Cost / Trip (buy)</span><span class="tmit-result-val icy">\u2212$${item ? Math.round(item.buyPrice * item.actualCap).toLocaleString() : '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Net Profit / Trip</span><span class="tmit-result-val green">$${item ? Math.round(item.profitPerItem * item.actualCap).toLocaleString() : '\u2014'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Flight Type</span><span class="tmit-result-val gold">${({'economy':'Economy','airstrip':'Airstrip -30%','business':'Business -50%','wlt':'WLT -50%'})[settings.flightType] ?? 'Economy'}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">One-way time</span><span class="tmit-result-val">${getAdjustedTravelTime(r.travelTime)} min</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Round Trip</span><span class="tmit-result-val">${r.roundTripHours.toFixed(1)} hrs</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Profit / Hour</span><span class="tmit-result-val gold">${formatPPH(r.profitPerHour)}</span></div>
          <div class="tmit-result-row"><span class="tmit-result-label">Stock Data</span><span class="tmit-result-val ${item?.stockConf === 'yata' ? 'green' : ''}">${
            item?.stockConf === 'yata' && typeof item?.stockQty === 'number'
              ? (item.stockQty === 0 ? 'YATA: EMPTY' : `YATA: ${item.stockQty} listed \u2713`)
              : 'Assumed full'
          }</span></div>
        </div>`;
      });
    });
  }

  // ── Crimes Tab ─────────────────────────────────────────────────────────────

  function renderCrimesTab() {
    const bestEl = document.getElementById('tmit-crime-best');
    const listEl = document.getElementById('tmit-crime-list');
    if (!bestEl || !listEl) return;

    const rates = computeCrimeRates();
    const fmtM  = n => n >= 1_000_000 ? '$' + (n/1_000_000).toFixed(2) + 'M'
                    : n >= 1_000     ? '$' + Math.round(n/100)/10 + 'K'
                                     : '$' + Math.round(n).toLocaleString();

    if (!rates) {
      bestEl.innerHTML = '';
      listEl.innerHTML = `<div class="tmit-state-msg" style="padding:18px 0;">
        <div class="tmit-state-icon">\ud83c\udfaf</div>
        Need at least 2 crime snapshots ${crimeSnapshots.length}/2.
        First sample lands within 5 minutes; meaningful rates after ~1 hour of play.
      </div>`;
    } else if (rates.perCrime.length === 0) {
      // We have snapshots but no movement — usually means we're reading the
      // wrong fields from the API response. Surface that explicitly with
      // copy-paste-ready debug info.
      const last       = crimeSnapshots[crimeSnapshots.length - 1];
      const src        = (last?.offenses && Object.keys(last.offenses).length)
        ? last.offenses
        : (last?.crimes || {});
      const keyCount   = Object.keys(src).length;
      const sampleKeys = keyCount ? Object.keys(src).slice(0, 6).join(', ') : '\u2014';
      bestEl.innerHTML = '';
      listEl.innerHTML = `<div class="tmit-state-msg" style="padding:18px 0;text-align:left;font-size:11px;line-height:1.7;">
        <div style="text-align:center;font-size:24px;margin-bottom:8px;">\ud83d\udd0d</div>
        <div style="color:#ffe066;font-weight:700;text-align:center;margin-bottom:8px;">No crime activity detected</div>
        <div style="color:#a08fc0;">
          TEEM has <b style="color:#c9a227;">${crimeSnapshots.length}</b> snapshots over <b style="color:#c9a227;">${rates.windowHours.toFixed(1)}h</b>,
          tracking <b style="color:#c9a227;">${keyCount}</b> crime key${keyCount === 1 ? '' : 's'}:
          <br><span style="font-family:monospace;font-size:10px;color:#9886b8;">${sampleKeys || '(none)'}</span>
          <br><br>
          If you've done crimes recently and nothing shows here, the Torn API
          probably moved the crime counters. Open <b>F12 \u2192 Console</b> and look
          for <code style="background:rgba(0,0,0,0.4);padding:1px 5px;border-radius:3px;color:#ffe066;">[TEEM Crimes]</code> \u2014
          share the line with the developer and we'll patch the parser.
        </div>
      </div>`;
      return;
    } else {
      const top3 = rates.perCrime.slice(0, 3);
      bestEl.innerHTML = `
        <div class="tmit-section-title" style="margin:0 0 6px;">\u26a1 Your Top 3 ${rates.schema === 'v2' ? 'Categories' : 'Crimes'} (last ${rates.windowHours.toFixed(1)}h)</div>
        ${top3.length === 0
          ? '<div style="font-size:11px;color:#9886b8;padding:6px 0;">No crime activity detected in window.</div>'
          : `<div style="display:flex;flex-direction:column;gap:6px;">
              ${top3.map((c, i) => {
                const medal = i === 0 ? '\ud83e\udd47' : i === 1 ? '\ud83e\udd48' : '\ud83e\udd49';
                const rankCol = i === 0 ? '#ffe066' : i === 1 ? '#c0c0c0' : '#cd7f32';
                return `<div style="display:grid;grid-template-columns:28px 1fr 90px 80px;gap:8px;
                          align-items:center;padding:7px 10px;background:rgba(0,0,0,0.3);
                          border:1px solid rgba(201,162,39,0.18);border-left:3px solid ${rankCol};
                          border-radius:6px;">
                  <div style="font-size:16px;text-align:center;">${medal}</div>
                  <div>
                    <div style="font-size:12px;color:#e8caf5;font-weight:600;">${c.name}</div>
                    <div style="font-size:9px;color:#9886b8;">${c.attempts} attempts \u00b7 ${(c.share*100).toFixed(0)}% of recent activity</div>
                  </div>
                  <div style="text-align:right;font-family:monospace;font-size:12px;color:#ffe066;font-weight:700;">${c.attemptsPerHr.toFixed(1)}/hr</div>
                  <div style="text-align:right;font-family:monospace;font-size:10px;color:#c9a227;">${c.totalAllTime.toLocaleString()} all-time</div>
                </div>`;
              }).join('')}
            </div>
            ${rates.moneyPerHr
              ? `<div style="margin-top:8px;font-size:10px;color:#a08fc0;text-align:center;">
                  Aggregate crime money rate: <b style="color:#50dc82;">${fmtM(rates.moneyPerHr)}/hr</b>
                  \u00b7 Torn doesn't expose per-category money in Crimes 2.0
                </div>`
              : `<div style="margin-top:8px;font-size:10px;color:#9886b8;text-align:center;">Crimes 2.0 doesn't expose per-category money \u2014 attempts are the source of truth.</div>`}
          `}
        ${(rates.schema === 'v2' && rates.skills && Object.keys(rates.skills).length > 0)
          ? `<div class="tmit-section-title" style="margin:14px 0 6px;">\ud83c\udfaf Skill Ladder</div>
             <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:5px;">
               ${Object.entries(rates.skills)
                  .filter(([, v]) => typeof v === 'number')
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 8)
                  .map(([k, v]) => {
                    const pct = Math.max(0, Math.min(100, v));
                    const isMax = v >= 100;
                    const barCol = isMax ? '#ffe066' : pct >= 75 ? '#50dc82' : pct >= 40 ? '#c9a227' : '#9886b8';
                    return `<div style="padding:5px 8px;background:rgba(0,0,0,0.25);
                              border:1px solid rgba(201,162,39,0.12);border-radius:5px;">
                      <div style="display:flex;justify-content:space-between;align-items:center;font-size:10px;
                                 color:#e8caf5;margin-bottom:3px;">
                        <span style="font-weight:600;">${prettifyCrimeKey(k)}</span>
                        <span style="font-family:monospace;color:${barCol};font-weight:700;">${v}${isMax ? ' \u2605' : ''}</span>
                      </div>
                      <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:${barCol};border-radius:2px;"></div>
                      </div>
                    </div>`;
                  }).join('')}
             </div>
             <div style="margin-top:6px;font-size:9px;color:#9886b8;text-align:center;">
               Skills cap at 100. \u2605 marks maxed sub-crimes.
             </div>`
          : ''}
      `;

      if (rates.perCrime.length === 0) {
        listEl.innerHTML = `<div class="tmit-state-msg" style="padding:14px 0;font-size:11px;">
          No crime activity in the last 24 hours.
        </div>`;
      } else {
        const rows = rates.perCrime.map(c => {
          const rateLabel = c.attemptsPerHr > 0
            ? `${c.attemptsPerHr.toFixed(1)}/hr`
            : `<span style="color:#5f4a78;">idle</span>`;
          return `<div style="display:grid;grid-template-columns:1fr 70px 70px 90px;
                    padding:5px 8px;border-bottom:1px solid rgba(255,255,255,0.04);
                    align-items:center;font-size:11px;">
            <div style="color:#e8caf5;">${c.name}</div>
            <div style="text-align:right;font-family:monospace;">${c.attempts}</div>
            <div style="text-align:right;font-family:monospace;">${rateLabel}</div>
            <div style="text-align:right;font-family:monospace;color:#c9a227;">${c.totalAllTime.toLocaleString()}</div>
          </div>`;
        });
        listEl.innerHTML = `<div style="display:grid;grid-template-columns:1fr 70px 70px 90px;
            padding:4px 8px;background:rgba(0,0,0,0.4);border:1px solid rgba(201,162,39,0.12);
            border-radius:4px 4px 0 0;margin-bottom:1px;font-size:9px;font-weight:700;
            letter-spacing:0.05em;color:#b481cc;text-transform:uppercase;">
            <div>${rates.schema === 'v2' ? 'Category' : 'Crime'}</div>
            <div style="text-align:right">Recent</div>
            <div style="text-align:right">Rate</div>
            <div style="text-align:right">All-time</div>
          </div>` + rows.join('');
      }
    }
  }

  // ── War Gear Tab ──────────────────────────────────────────────────────────

  // v6.7.3 — Inline SVG sparkline for the War Gear tab. Takes a price
  // history array (same shape stored in priceHistory[itemId]) and renders a
  // small polyline showing the last `days` of price movement. Returns ''
  // when there isn't enough data to draw a meaningful line (< 2 valid
  // datapoints in the window) so the caller can render a "no data"
  // placeholder.
  //
  // Color codes the line by trend: green when the last datapoint is at or
  // above the first in the window (uptrend/flat), red when below. SVG uses
  // a fixed viewBox with non-scaling stroke; the parent .tmit-war-spark
  // sets width via CSS (flex-grown) and a fixed 14px height.
  function buildWarSparkline(history, days) {
    if (!Array.isArray(history) || history.length < 2) return '';
    const cutoff = Date.now() - days * 86400000;
    const win = history.filter(h => h && h.ts >= cutoff
      && ((h.price && h.price > 0) || (h.yataPrice && h.yataPrice > 0)));
    if (win.length < 2) return '';
    const prices = win.map(h => h.price || h.yataPrice);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min;
    const VB_W = 100, VB_H = 14;
    const stepX = VB_W / (prices.length - 1);
    const points = prices.map((p, i) => {
      const x = i * stepX;
      // Flat line edge case (all-equal prices) — draw a centered
      // horizontal line so the cell still reads as "data present".
      const y = range > 0
        ? VB_H - ((p - min) / range) * (VB_H - 2) - 1
        : VB_H / 2;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const trending = prices[prices.length - 1] >= prices[0];
    const color = trending ? '#50dc82' : '#ff6b6b';
    return `<svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderWarTab() {
    const listEl = document.getElementById('tmit-war-tracker-list');
    if (!listEl) return;

    // v6.7.3 — Widened the analysisCache pull from a thin
    // (price + changePct) name-keyed map to the full row keyed by name, so
    // each war item can render the BUY/SELL signal pill + confidence dots
    // (and any future per-row analysis fields) without re-walking the cache.
    const rowByName = {};
    for (const r of analysisCache) rowByName[r.name] = r;

    const warItems = Object.entries(itemMeta)
      .filter(([, m]) => isRWItem(m.name, m.type))
      .map(([idStr, m]) => {
        const r = rowByName[m.name];
        return {
          itemId:       parseInt(idStr, 10),
          name:         m.name,
          type:         m.type,
          currentPrice: r ? r.currentPrice : (m.market_value ?? 0),
          changePct:    r ? (r.changePct ?? 0) : 0,
          signal:       r ? r.signal : null,
          confidence:   r ? (r.confidence ?? 0) : 0,
          thinData:     r ? !!r.thinData : true,
        };
      });

    if (warItems.length === 0) {
      listEl.innerHTML = `<div class="tmit-state-msg" style="padding:16px 0;">
        <div class="tmit-state-icon" style="font-size:20px">\u2694</div>
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
      const bbDollar = bbVal > 0 ? `$${Math.round(bbVal * dollarsPerBB / 1_000_000)}M` : '\u2014';

      // Rarity dot indicator
      const rarityDot = rarity === 'red'    ? '<span style="color:#ff4040;font-size:8px">\u25cf</span> '
                      : rarity === 'orange' ? '<span style="color:#e8621a;font-size:8px">\u25cf</span> '
                      : rarity === 'yellow' ? '<span style="color:#ffe066;font-size:8px">\u25cf</span> '
                      : '';

      // v6.7.3 \u2014 Signal pill + confidence dots. Reuses the same signal
      // values that drive the main Market tab's badges. Null signal = no
      // analysis yet (item has no price history in the active window);
      // render a muted placeholder so the meta row still aligns.
      let sigPill;
      if (r.signal) {
        const confDots = [1, 2, 3].map(i =>
          `<span class="tmit-war-sig-dot${i <= r.confidence ? ' filled' : ''}"></span>`
        ).join('');
        sigPill = `<span class="tmit-war-sig ${r.signal}" title="${r.signal} \u00b7 confidence ${r.confidence}/3${r.thinData ? ' (thin data)' : ''}">${r.signal}<span class="tmit-war-sig-dots">${confDots}</span></span>`;
      } else {
        sigPill = `<span class="tmit-war-sig WATCH" style="opacity:0.55" title="No price history yet for this item">\u2014</span>`;
      }

      // v6.7.3 \u2014 7-day price sparkline. priceHistory keys are stringified
      // (Object.keys returns strings even for numeric assignments).
      const hist = priceHistory[r.itemId] || priceHistory[String(r.itemId)] || [];
      const sparkSvg = buildWarSparkline(hist, 7);
      const sparkCell = sparkSvg
        ? `<span class="tmit-war-spark" title="7d price trend">${sparkSvg}</span>`
        : `<span class="tmit-war-spark empty" title="Need more poll cycles for a 7d trend">no 7d data</span>`;

      // v6.8.0 \u2014 Bazaar pill + per-row check button.
      // Pill only renders when there's a meaningful undercut; button is
      // always available (one click \u2192 fetchBazaarOnDemand).
      const bazPill = buildBazaarPill(r.itemId, r.currentPrice, { compact: true });
      const bazFresh = bazaarIsFresh(r.itemId);
      const bazBtn = `<button class="tmit-war-bazaar-btn" data-id="${r.itemId}"
        title="Check Bazaar price (1 API call \u00b7 30-min cache)"
        style="opacity:${bazFresh ? '0.5' : '1'};">\ud83d\udcb0</button>`;

      return `<div class="tmit-war-row ${rarity ? rarity+'-item' : ''}">
        <div class="tmit-war-info">
          <div class="tmit-war-name" title="${r.name}">${rarityDot}${r.name}</div>
          <div style="font-size:9px;color:#9886b8">${r.type}${weapType ? ' \u00b7 '+weapType : ''}</div>
          <div class="tmit-war-meta">
            ${sigPill}
            ${sparkCell}
            ${bazPill}
            ${bazBtn}
          </div>
        </div>
        <div class="tmit-war-price" style="text-align:right">$${r.currentPrice >= 1_000_000
          ? (r.currentPrice/1_000_000).toFixed(1)+'M'
          : r.currentPrice.toLocaleString()}</div>
        <div class="tmit-war-bb" style="text-align:right">${bbVal ? bbVal+' BB' : '\u2014'}</div>
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
        msg = `<div class="tmit-state-msg"><div class="tmit-state-icon">\u2b50</div>Your watchlist is empty.<br><span style="font-size:11px">Click any <b style="color:#80b0ff">WATCH</b> badge on the All Items tab to pin it here.</span></div>`;
      } else if (Object.keys(priceHistory).length === 0) {
        msg = `<div class="tmit-state-msg"><div class="tmit-state-icon">\u23f3</div>Collecting data\u2026 check back after the first poll completes.</div>`;
      } else {
        msg = `<div class="tmit-state-msg"><div class="tmit-state-icon">\ud83d\udd0d</div>No items match your filters.</div>`;
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
      if (r.changePct >= 30)       { rowClass = 'tmit-item-row tmit-hot-big'; spikeIcon = '\ud83d\udd25'; }
      else if (r.changePct >= 15)  { rowClass = 'tmit-item-row tmit-hot';     spikeIcon = '\ud83d\udd25'; }
      else if (r.changePct > 0)    { rowClass = 'tmit-item-row tmit-hot'; }
      else if (r.changePct <= -30) { rowClass = 'tmit-item-row tmit-icy-big'; spikeIcon = '\ud83e\uddca'; }
      else if (r.changePct <= -15) { rowClass = 'tmit-item-row tmit-icy';     spikeIcon = '\ud83e\uddca'; }
      else if (r.changePct < 0)    { rowClass = 'tmit-item-row tmit-icy'; }
      const confDots    = [1,2,3].map(i =>
        `<div class="tmit-conf-dot${i <= r.confidence ? ' filled' : ''}"></div>`
      ).join('');

      const isPinned   = watchlist.has(r.itemId);
      const finalClass = rowClass + (isPinned ? ' tmit-pinned' : '');
      const watchedCls = isPinned ? ' tmit-watched' : '';
      const badgeTitle = isPinned ? 'Click to remove from watchlist' : 'Click to add to watchlist';

      const bazaarPill = buildBazaarPill(r.itemId, r.currentPrice, { compact: true });
      return `
        <div class="${finalClass}" data-item-id="${r.itemId}">
          <div>
            <div class="tmit-item-name">
              ${spikeIcon ? `<span class="tmit-spike-icon">${spikeIcon}</span>` : ''}${r.name}
            </div>
            <div class="tmit-item-type">${r.type}${bazaarPill ? ' \u00b7 ' + bazaarPill : ''}</div>
          </div>
          <div class="tmit-price">$${r.currentPrice.toLocaleString()}</div>
          <div class="tmit-change ${changeClass}">${changeSign}${r.changePct}%</div>
          <div class="tmit-signal">
            <span class="tmit-signal-badge ${r.signal}${watchedCls}" title="${badgeTitle}">${r.signal}</span>
            <div class="tmit-confidence-bar" style="justify-content:flex-end;margin-top:2px">${confDots}</div>
          </div>
          <div style="display:flex;gap:3px;align-items:center;">
            <button class="tmit-row-btn tmit-pin-row" data-id="${r.itemId}"
              title="${isPinned ? 'Remove from watchlist' : 'Add to watchlist'}"
              style="color:${isPinned ? '#c9a227' : 'rgba(201,162,39,0.3)'};">\u2605</button>
            <button class="tmit-row-btn tmit-bazaar-btn" data-id="${r.itemId}"
              title="Check Bazaar price (1 API call \u00b7 30-min cache)" style="color:#ffc94d;">\ud83d\udcb0</button>
            <button class="tmit-row-btn tmit-buy-btn" data-id="${r.itemId}" data-name="${r.name}" data-cat="${r.type}"
              title="Buy on market" style="color:#3dd6c8;">\ud83d\uded2</button>
            <button class="tmit-row-btn tmit-sell-btn" data-id="${r.itemId}" data-name="${r.name}"
              title="List on market (opens Items page)" style="color:#e8621a;">\ud83d\udcb5</button>
          </div>
        </div>`;
    });

    const overflowMsg = truncated
      ? `<div style="padding:14px 16px;text-align:center;font-size:11px;color:#a08fc0;border-top:1px solid rgba(151,2,173,0.18);background:rgba(0,0,0,0.25);">
           Showing top <b style="color:#c9a227">${MAX_RENDERED_ROWS}</b> of <b style="color:#c9a227">${totalMatched.toLocaleString()}</b> items
           \u2014 narrow down with search, category or filters to see more.
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

    const stockStr = (top.bestItem?.stockConf === 'yata' && typeof top.bestItem?.stockQty === 'number')
      ? ` \u00b7 Stock: ${top.bestItem.stockQty} listed`
      : '';

    const cdStr = [];
    if (myBattleStats?.drugCd > 0)    cdStr.push('Drug CD: ' + formatCooldown(myBattleStats.drugCd));
    if (myBattleStats?.boosterCd > 0) cdStr.push('Booster CD: ' + formatCooldown(myBattleStats.boosterCd));

    const body = [
      `${top.flagEmoji} ${top.country} \u2014 ${formatPPH(top.profitPerHour)}`,
      `${top.bestItem?.itemName ?? ''} \u00b7 ${flightLabel} \u00b7 ${oneWay}min each way${stockStr}`,
      cdStr.length ? cdStr.join(' \u00b7 ') : 'No active cooldowns \u2713',
    ].join('\n');

    lastTopTravelCode = top.code;
    lastTopTravelPPH  = top.profitPerHour;
    store('lastTravelCode', lastTopTravelCode);
    store('lastTravelPPH',  lastTopTravelPPH);
    store('lastTravelAlertWindow', windowKey);

    // Torn PDA's WebView has no browser Notification API; the in-panel data
    // updates remain the user's signal there. Guard so we don't throw.
    if (!IS_PDA && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification('TEEM \u2708 Good Time to Fly!', { body, icon: '', silent: false });
      } catch(e) {}
    }
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
    travelRanking = rankTravelDestinations(marketPrices, yataStockCache, yataTravelPriceCache, capacity);
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
        i+1, r.country, r.bestItem?.itemName ?? '\u2014',
        r.bestItem?.buyPrice ?? 0, r.bestItem?.netSellPrice ?? 0,
        r.bestItem?.profitPerItem ?? 0, r.bestItem?.actualCap ?? 0,
        r.bestItem ? Math.round(r.bestItem.profitPerItem * r.bestItem.actualCap) : 0,
        r.roundTripHours.toFixed(1), r.profitPerHour, r.bestItem?.stockConf ?? '\u2014'
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
          return [r.name, r.type, r.currentPrice, bb, Math.round(bb * dollarsPerBB), r.changePct];
        });
    } else if (tab === 'crimes') {
      const rates = computeCrimeRates();
      headers = ['Crime','Attempts (window)','Attempts/hr','Est $/hr','All-time'];
      rows = rates
        ? rates.perCrime.map(c => [
            c.name, c.attempts, c.attemptsPerHr.toFixed(2),
            c.moneyPerHr ?? '\u2014', c.totalAllTime,
          ])
        : [];
    }

    if (!rows.length) {
      // Show brief feedback
      const btn = document.getElementById('tmit-btn-export');
      if (btn) { btn.textContent = '\u2717 No data'; setTimeout(() => btn.textContent = '\u2b07 CSV', 1500); }
      return;
    }

    const csv = [headers, ...rows].map(r => r.map(v =>
      typeof v === 'string' && v.includes(',') ? `"${v}"` : v
    ).join(',')).join('\n');

    try {
      navigator.clipboard.writeText(csv).then(() => {
        const btn = document.getElementById('tmit-btn-export');
        if (btn) { btn.textContent = '\u2713 Copied!'; setTimeout(() => btn.textContent = '\u2b07 CSV', 2000); }
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
      ? `$${(watchedVal/1_000_000).toFixed(1)}M` : '\u2014';

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

  // Force the panel back inside the viewport. Used on drag, on open (rescues
  // positions saved from a larger viewport / removed monitor), and on resize.
  // Skips when the @media(max-width:768px) rule has taken over — there CSS
  // pins the panel and computed left/top would fight the !important rules.
  // PANEL_MARGIN keeps the panel an inch off every viewport edge so its
  // gold border-top, header ::before gradient, and outer box-shadow glow
  // don't get visually clipped against the chrome.
  const PANEL_MARGIN = 10;
  function clampPanelPos(elNode, persist) {
    if (!elNode || elNode.classList.contains('tmit-hidden')) return;
    if (window.innerWidth <= 768) return;
    const rect = elNode.getBoundingClientRect();
    const vw   = window.innerWidth;
    const vh   = window.innerHeight;
    let left = parseInt(elNode.style.left, 10);
    let top  = parseInt(elNode.style.top,  10);
    if (Number.isNaN(left)) left = rect.left;
    if (Number.isNaN(top))  top  = rect.top;
    const maxLeft = Math.max(PANEL_MARGIN, vw - rect.width  - PANEL_MARGIN);
    const maxTop  = Math.max(PANEL_MARGIN, vh - rect.height - PANEL_MARGIN);
    const cL = Math.min(maxLeft, Math.max(PANEL_MARGIN, left));
    const cT = Math.min(maxTop,  Math.max(PANEL_MARGIN, top));
    elNode.style.right  = 'auto';
    elNode.style.bottom = 'auto';
    elNode.style.left   = cL + 'px';
    elNode.style.top    = cT + 'px';
    if (persist) {
      settings.posX = cL;
      settings.posY = cT;
      saveSettings();
    }
  }

  // FAB size toggle. Double-clicking the FAB on desktop swaps between the
  // default (84px / 64px mobile) and compact half-size (42px / 36px).
  // Actual dimensions live in CSS — this just swaps a class and persists.
  // We pass the TARGET size to clampFabPos because the `transition:all 0.3s`
  // rule means getBoundingClientRect would return the in-progress animated
  // size, leaving an enlarging-at-bottom-edge FAB clipped during the 300ms
  // animation.
  function toggleFabSize(fab) {
    if (!fab) return;
    const goingSmall = !fab.classList.contains('tmit-fab-small');
    fab.classList.toggle('tmit-fab-small', goingSmall);
    settings.fabSize = goingSmall ? 'small' : 'normal';
    saveSettings();
    const narrow = window.innerWidth <= 768;
    const targetSize = goingSmall ? (narrow ? 36 : 42) : (narrow ? 64 : 84);
    clampFabPos(fab, true, { w: targetSize, h: targetSize });
  }

  // FAB clamp. Mirrors clampPanelPos but allows the FAB to sit flush with
  // the viewport edges (no PANEL_MARGIN), since users like parking it in
  // the corner. Called after restoring a saved fabX/fabY and on resize.
  // If left/top aren't set (FAB is still using the default right/bottom
  // inline anchor), nothing to clamp. The optional sizeOverride is used by
  // toggleFabSize to avoid clamping against the mid-animation rect during
  // the CSS size transition.
  function clampFabPos(fab, persist, sizeOverride) {
    if (!fab) return;
    let left = parseInt(fab.style.left, 10);
    let top  = parseInt(fab.style.top,  10);
    if (Number.isNaN(left) || Number.isNaN(top)) return;
    let w, h;
    if (sizeOverride) {
      w = sizeOverride.w; h = sizeOverride.h;
    } else {
      const rect = fab.getBoundingClientRect();
      w = rect.width; h = rect.height;
    }
    const maxLeft = Math.max(0, window.innerWidth  - w);
    const maxTop  = Math.max(0, window.innerHeight - h);
    const cL = Math.min(maxLeft, Math.max(0, left));
    const cT = Math.min(maxTop,  Math.max(0, top));
    if (cL === left && cT === top) return;
    fab.style.left = cL + 'px';
    fab.style.top  = cT + 'px';
    if (persist) {
      settings.fabX = cL;
      settings.fabY = cT;
      saveSettings();
    }
  }

  function makeDraggable(el, handle) {
    let ox = 0, oy = 0, startX = 0, startY = 0, maxLeft = 0, maxTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // Don't start a drag from interactive header controls (close/settings/refresh
      // buttons). Their click handlers still fire normally because we don't
      // preventDefault on those targets.
      if (e.target.closest('button, input, select')) return;
      e.preventDefault();
      startX = e.clientX;
      startY = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left;
      oy = rect.top;
      maxLeft = Math.max(PANEL_MARGIN, window.innerWidth  - rect.width  - PANEL_MARGIN);
      maxTop  = Math.max(PANEL_MARGIN, window.innerHeight - rect.height - PANEL_MARGIN);

      function onMove(e) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        el.style.right  = 'auto';
        el.style.bottom = 'auto';
        el.style.left   = Math.min(maxLeft, Math.max(PANEL_MARGIN, ox + dx)) + 'px';
        el.style.top    = Math.min(maxTop,  Math.max(PANEL_MARGIN, oy + dy)) + 'px';
      }

      function onUp(e) {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        settings.posX = parseInt(el.style.left);
        settings.posY = parseInt(el.style.top);
        saveSettings();
      }

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
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

    // Tap-to-show tooltips for ? help dots. Desktop users still get hover
    // tooltips via CSS; tapping the ? on mobile/PDA toggles the same tooltip,
    // and tapping anywhere else closes it.
    document.addEventListener('click', (e) => {
      const help = e.target.closest && e.target.closest('.tmit-help');
      // Close any open tooltip not under the current target
      document.querySelectorAll('.tmit-help.tmit-help-active').forEach(el => {
        if (el !== help) el.classList.remove('tmit-help-active');
      });
      if (help) {
        help.classList.toggle('tmit-help-active');
        e.stopPropagation();
      }
    });

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

    // Re-clamp the panel if the viewport shrinks (window resize, devtools
    // open, browser-zoom change, mobile rotation). rAF-debounced so we run
    // once per frame even when resize fires every pixel.
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        const panel = document.getElementById('tmit-panel');
        if (panel && !panel.classList.contains('tmit-hidden')) {
          clampPanelPos(panel, true);
        }
        // FAB: clamp dragged position into the new bounds. If the user
        // never dragged (no saved coords), clampFabPos no-ops and the CSS
        // defaults (base rule on desktop, @media rule on mobile) stay in
        // effect. We no longer wipe the FAB sides on narrow viewports — that
        // path threw away the user's only-visible position on FF Android.
        const fab = document.getElementById('tmit-fab');
        if (fab) clampFabPos(fab, true);
      });
    });

    // Tampermonkey menu: emergency reset for the panel position. If a saved
    // posX/posY ever leaves the drag handle unreachable (e.g. stored before
    // the clamp shipped, or saved on a since-removed monitor), the user can
    // trigger this from the TM icon dropdown to snap the panel back home.
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('TEEM: Reset panel + FAB position', () => {
          settings.posX = null;
          settings.posY = null;
          settings.fabX = null;
          settings.fabY = null;
          settings.fabSize = 'normal';
          saveSettings();
          const panel = document.getElementById('tmit-panel');
          const fab   = document.getElementById('tmit-fab');
          if (fab) {
            // Drop any inline left/top so the default `bottom:28px;right:28px`
            // from the inline cssText takes over. Mobile @media kicks in too
            // because there's nothing inline overriding it now. Also wipe
            // the small-size class so the FAB returns to its full footprint.
            fab.style.left = '';
            fab.style.top  = '';
            fab.classList.remove('tmit-fab-small');
          }
          if (panel && fab) {
            // Force the "first-open" branch in openPanel() to re-compute
            // position relative to the FAB and re-clamp to viewport.
            panel.style.left = '';
            panel.style.top  = '';
            if (panel.classList.contains('tmit-hidden')) {
              openPanel(fab, panel);
            } else {
              panel.classList.add('tmit-hidden');
              openPanel(fab, panel);
            }
          }
        });
      } catch(e) {}
    }

    // Notification permission request (needed for travel + spike alerts).
    // Skip on Torn PDA — its WebView has no Notification API and accessing it
    // would throw. The FAB coin badge still works as a visual spike alert.
    if (!IS_PDA && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch(e) {}
    }

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
      buildOnboarding();
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
        setStatus('ok', `Cached \u00b7 ${new Date().toLocaleTimeString()}`);
      }
      // Polling runs from script load so the FAB spike-alert can pulse
      // even when the panel is closed. Session/footer DOM timers stay
      // gated to panel-open via resumeBackgroundWork() in openPanel().
      startPolling();
    }

    // Fetch my own battlestats on startup (silently)
    if (settings.apiKey) { setTimeout(() => fetchMyBattleStats(settings.apiKey), 3000); }
  }

  // Navigate to the item market filtered to a specific item. We don't try
  // to auto-click the listing — Torn's market is a React app with hashed
  // class names that change, and any modern bot-snipe would beat us to
  // the cheapest listing anyway. Reliable beats clever.
  function openItemMarket(itemId, itemName, category) {
    const cat = category || '';
    window.location.href = itemId
      ? `https://www.torn.com/page.php?sid=ItemMarket#/market/view=category&categoryName=${encodeURIComponent(cat)}&itemID=${itemId}`
      : 'https://www.torn.com/page.php?sid=ItemMarket';
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

  function safeInit() {
    try { init(); } catch(e) {
      // If init crashes, at minimum show the FAB so user knows TEEM is there
      const f = document.createElement('div');
      f.id = 'tmit-fab';
      f.style.cssText = 'position:fixed;bottom:28px;right:28px;width:52px;height:52px;border-radius:50%;background:#2d1b69;border:2px solid #c9a227;display:flex;align-items:center;justify-content:center;font-size:22px;cursor:pointer;z-index:2147483646;';
      f.textContent = '\ud83d\udc18';
      f.title = 'TEEM error: ' + e.message;
      f.onclick = () => alert('TEEM init error: ' + e.message + '\n\nTry clearing TEEM storage in Tampermonkey dashboard.');
      document.body.appendChild(f);
    }
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
        f.textContent = '\ud83d\udc18';
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
