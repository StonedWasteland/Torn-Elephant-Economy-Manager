# 🐘 TEEM — Torn's Elephant Economy Manager

> A Tampermonkey userscript for [Torn City](https://www.torn.com) that brings live market signals, travel profit rankings, war gear pricing, and a personal crime $/hour tracker into a single overlay — without ever leaving the game.

Designed to run alongside [TornTools](https://chromewebstore.google.com/detail/torntools/hjpaapdjcgbmeikfnahipphknonhlhib?hl=en).

---

## ✨ Features

### 📈 Market Tracker
- Tracks **all item prices** in real time using the Torn API + YATA cross-reference
- **Hot/cold signal system** — BUY, HOLD, WATCH, SELL with confidence ratings
- Price change % shown in **burnt orange (rising)** and **icy turquoise (falling)**
- Filters by category, timeframe (1H → 1M), budget cap, minimum % change, and search
- Sortable columns — price, change %, signal strength
- Automatic spike detection with **🔥 and 🧊 row highlighting** for 15%+ and 30%+ moves
- Live pricing via Torn API v2 with smart fallback to v1 and YATA
- **FAB spike alert** — coin badge appears on the elephant when any tracked item moves 50%+, color-coded by item type (drug, plushie, weapon, etc.)

### ⭐ Watchlist
- Click any signal badge to pin an item — lights up gold and pins to your personal watchlist
- Dedicated Watchlist tab shows only your pinned items
- Persists across sessions

### ⚔ War Gear
- **Live market prices** for all ranked war weapons & armor
- Rarity dot indicator (yellow / orange / red) based on price
- **BB trade-in value** + dollar equivalent shown per item
- Sortable, hot/cold change indicator
- Detects RW items by hardcoded weapon list (most reliable) and Torn API type strings

### ✈ Travel Profit Tracker
- Ranks all **11 destinations** by profit/hour in real time
- Accounts for **5% Torn sales tax**, your carry capacity, flight type, and YATA stock levels
- **Flight type selector** — Economy / Airstrip (−30%) / Business / WLT (−50%)
- Click any destination for full trip breakdown — buy price, sell price, net after tax, effective carry, total profit, profit/hr
- Stock confidence badge — **YATA ✓** (live crowd-sourced) vs **~stock** (assumed full)
- Browser notifications when the top destination changes or improves significantly
- Configurable alert gates: drug cooldown clear, booster cooldown clear, stock confirmed

### 🎯 Crime Tracker
- Snapshots your crime activity every 5 minutes via the Torn API
- Computes **attempts/hour** and estimated **$/hour** per crime
- Ranks your **top 3 crimes** by activity with medal indicators (🥇🥈🥉)
- Full 24-hour breakdown of every crime you've committed
- Money rate measured from your actual personalstats deltas — no guesswork

### 💡 Quality of Life
- **First-time onboarding** — non-blocking slide-in wizard, auto-detects carry capacity, validates your API key live
- **Session tracker bar** — live watched-item inventory estimate + session profit/loss
- **Data age indicator** — green/yellow/red dot showing how fresh your prices are
- **⬇ CSV export** — export any tab's data to clipboard or file
- **Alt+T keyboard shortcut** — toggle the panel from anywhere on Torn
- **Draggable FAB and panel** — position them anywhere, saved across sessions
- **Inline tooltips** — hover ? icons for plain-English explanations of every signal and metric
- **Tiered history compaction** — keeps long-term trends without storage bloat (last 24h full resolution, hourly to 7d, 6-hourly to 30d, daily after)

---

## 🚀 Installation

### Requirements
- **Desktop**: [Tampermonkey](https://www.tampermonkey.net/) on Chrome, Firefox, Edge, or Opera GX
- **Mobile**: [Torn PDA](https://www.tornpda.com/) — the official Torn mobile app supports custom userscripts natively

### Desktop (Tampermonkey)
1. Open the [`TornElephantEconomyManager.user.js`](TornElephantEconomyManager.user.js) file in this repo
2. Click the **Raw** button on GitHub — Tampermonkey will detect it and show an Install dialog
3. Click **Install**

Or manually:
1. Open **Tampermonkey** → Dashboard → click the **+** tab
2. Select all the default template text and delete it
3. Paste the contents of `TornElephantEconomyManager.user.js`
4. Hit **Save** (Ctrl+S)

### Mobile (Torn PDA)
1. Open **Torn PDA** → **Settings** → **Userscripts**
2. Tap **+** to add a new script
3. Paste the contents of `TornElephantEconomyManager.user.js` (or import via raw GitHub URL if PDA prompts for one)
4. Make sure the script is **enabled** and reload any Torn page

The panel switches to a near-fullscreen layout on mobile, drag works via touch, and `?` tooltips become tap-to-show. System notifications are disabled on PDA — the FAB coin badge still flashes on spikes.

Refresh any `https://www.torn.com/*` page and the 🐘 button appears in the bottom-right.

---

## ⚙️ Setup

On first install, a small setup card slides in from the bottom-left corner:

1. **Step 1 — API Key**: Click the button to open your [Torn API settings](https://www.torn.com/preferences.php#tab=api) in a new tab. Create a **Limited** key with `Market`, `User`, and `Torn` access. Paste it back into the setup card — TEEM validates it live.
2. **Step 2 — Carry Capacity**: TEEM attempts to auto-detect from your inventory, faction, and job perks. If the number is wrong, type your actual value (check your in-game Travel page).
3. **Step 3 — Tab Tour**: Quick overview of all five tabs.
4. **Step 4 — You're ready**: Tips and keyboard shortcuts.

You can skip setup at any time and configure later via **⚙** in the panel header.

---

## 🎮 Usage

| Action | How |
|---|---|
| Open/close panel | Click the 🐘 TEEM button, or press **Alt+T** |
| Move the TEEM button | Drag it anywhere — position is saved |
| Move the panel | Drag the header bar |
| Add to watchlist | Click any signal badge — it lights up gold |
| Export data | Click **⬇ CSV** in the top bar |
| Force refresh | Click **↻** in the panel header |
| Change timeframe | Click 1H / 6H / 1D / 3D / 1W / 2W / 1M buttons |
| Filter by category | Use the dropdown next to timeframe buttons |
| Set budget cap | Enter max price in the filter row |
| Configure alerts | Open **⚙** settings — toggle spike-alert badge |

---

## 📊 How Signals Work

| Signal | Meaning |
|---|---|
| 🔥 **SELL** | Price up 5%+ over your selected timeframe — cash out into strength |
| 🏅 **HOLD** | Mild upward movement — wait for more upside before selling |
| 👁 **WATCH** | Volatile but no clear direction yet |
| 🧊 **BUY** | Price down 8%+ — buy the dip |

These are **Torn-flipper semantics** (buy low, sell high), not momentum trading.

**Confidence dots** (● ● ●) show how much data backs the signal:
- ● ● ● — Strong trend, lots of snapshots
- ● ● ○ — Moderate confidence
- ● ○ ○ — Early signal, thin data (improves over time)

> **Note:** TEEM builds its own price history locally. Signals get significantly smarter after 24–48 hours of running. The longer it runs, the better the data.

---

## 🗺️ Travel Rankings

TEEM ranks all 11 destinations by **profit per hour** accounting for:
- Round-trip flight time (adjusted for your selected flight type)
- In-country buy price
- Live Torn market sell price (after 5% tax)
- Your carry capacity
- YATA stock level (when available)

| Country | Primary Items | Flight (one-way, economy) |
|---|---|---|
| 🇲🇽 Mexico | Jaguar Plushie, Dahlia | 20 min |
| 🇨🇦 Canada | Wolverine Plushie, Crocus, Xanax | 41 min |
| 🇰🇾 Cayman Islands | Stingray Plushie, Banana Orchid | 57 min |
| 🌺 Hawaii | Orchid, Large Suitcase | 121 min |
| 🇬🇧 United Kingdom | Red Fox Plushie, Nessie Plushie, Heather, Xanax | 159 min |
| 🇨🇭 Switzerland | Chamois Plushie, Edelweiss, Flash Grenade, LSD | 169 min |
| 🇦🇷 Argentina | Monkey Plushie, Ceibo Flower, Tear Gas, LSD | 189 min |
| 🇨🇳 China | Panda Plushie, Peony, LSD, Opium | 219 min |
| 🇯🇵 Japan | Cherry Blossom, Xanax, Opium | 225 min |
| 🇦🇪 UAE | Camel Plushie, Tribulus Omanense | 259 min |
| 🇿🇦 South Africa | Lion Plushie, African Violet, Xanax, LSD, Opium | 297 min |

---

## 🪙 Bunker Bucks Reference

BB trade-in values shown in the War Gear tab (community verified):

| Rarity | Pistol/SMG | Melee | Shotgun/Rifle | Armour | Heavies |
|---|---|---|---|---|---|
| Yellow | 4 | 6 | 10 | 12 | 14 |
| Orange ×1 | 12 | 18 | 30 | 26 | 42 |
| Orange ×2 | 18 | 27 | 45 | 26 | 63 |
| Red ×1 | 36 | 54 | 90 | 108 | 126 |
| Red ×2 | 54 | 81 | 135 | 108 | 189 |

---

## 🔒 Privacy & Security

- Your API key is stored **locally** in Tampermonkey storage — it never leaves your machine except for direct calls to `api.torn.com` and `yata.life`
- Price history and crime snapshots are stored **locally** — nothing syncs anywhere or gets shared
- No ads, no tracking, no external servers — TEEM only ever talks to Torn's official API and YATA
- The script identifies itself to Torn's API logs as `TEEM` via the `comment` parameter — standard practice, not personally identifying

---

## 📋 Changelog

### v6.5.0 — Current
- 📱 **Torn PDA / mobile support** — the panel now adapts to phone-sized viewports (near-fullscreen with the same five tabs)
- Drag handlers rewritten with Pointer Events so the FAB and panel can be dragged with a finger as well as a mouse
- `?` help tooltips now tap-to-show on touch devices (hover still works on desktop)
- Browser `Notification` API calls guarded — TEEM no longer throws inside Torn PDA's WebView; FAB coin badge remains the visual spike alert there
- Fixed FAB drag-bounds clamp using a stale 56px value when the FAB is actually 84px
- Fixed Travel tab showing `—` instead of the item name under each destination (and in the trip details card)

### v6.4.0
- 🎯 **Crime Tracker tab** — snapshots crime activity every 5 min, ranks top 3 crimes by attempts/hr with measured $/hr
- Removed Quick Use tab — TornTools' Quick Sell covers this ground better
- New black-background JPEG logo embedded as 256×256 base64 (no external image dependencies)
- Rounded-square FAB with logo edge-to-edge; coin badge for 50%+ spikes hangs outside the corner without clipping
- Spike alert badge color-codes by item type (drug, weapon, plushie, flower, booster, etc.)
- Adaptive poll cadence — cold items rotate in every 3rd poll to prevent stale movers
- Hot/cold row highlighting refined (15% / 30% thresholds)
- Tiered history compaction prevents storage bloat over long-running installs
- Watchdog logs main-thread blocks > 500ms for freeze diagnosis

### v6.0+ — Pre-public
- Background polling restored so FAB spike alerts still pulse when panel is closed
- Fix zero-snapshots edge case on fresh installs when `torn/items` API fails
- Cap rendered rows at 200; debounce search to fix periodic freezing
- Skip UI work when panel is hidden; throttle history saves via `requestIdleCallback`
- Onboarding no longer auto-opens API page (fixed infinite-tab-loop bug)
- v2 item market API integration replacing stale v1 endpoint

### v3.x
- Full UX overhaul, onboarding wizard, auto-detect carry capacity, smart travel alerts, CSV export, Alt+T shortcut

### v2.x
- Travel tab with all 11 countries; War Gear tab; BB calculator integration

### v1.x
- Market tracker, watchlist, hot/cold theme, YATA integration

---

## 🤝 Contributing

Found a bug? Item ID wrong? Travel time off? Open an issue or submit a pull request. Community data verification is especially welcome for:
- Travel item buy prices (these can shift)
- BB trade-in values if Torn updates them
- New country items if Torn adds destinations
- Crime API field names if Torn restructures `personalstats`

---

## ⚠️ Disclaimer

TEEM is a fan-made tool and is not affiliated with or endorsed by Torn City or Chedburn Networks. Use it in accordance with [Torn's scripting rules](https://www.torn.com/forums.php#/p=threads&f=67&t=16066406). All market data is pulled from Torn's official API.

---

*Built with 💛 for the Torn community. May your markets be hot and your flights be profitable.*
