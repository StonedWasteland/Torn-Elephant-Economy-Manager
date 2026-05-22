# Torn-Elephant-Economy-Manager
Market/Travel Manager For Torn

Copy/paste the script into a new Tampermonkey tab, save it, refresh Torn, you're good to go!

# 🐘 TEEM — Torn's Elephant Economy Manager

> A Tampermonkey userscript for [Torn City](https://www.torn.com) that brings live market tracking, travel profit rankings, ranked war calculators, and Bunker Bucks tools into a single elegant overlay — without ever leaving the game.

---

## ✨ Features

### 📈 Market Tracker
- Tracks **all item prices** in real time using the Torn API + YATA cross-reference
- **Hot/cold signal system** — BUY, HOLD, WATCH, SELL signals with confidence ratings
- Price change % shown in **burnt orange (rising)** and **icy turquoise (falling)**
- Filters by category, timeframe (1H → 1M), budget cap, minimum % change, and search
- Sortable columns — price, change %, signal strength
- Automatic spike detection with **🔥 and 🧊 row highlighting** for 15%+ and 30%+ moves
- Live pricing via Torn API v2 where available, with v1 fallback

### ⭐ Watchlist
- Click any **WATCH** badge to pin an item — lights up gold and pins to your personal watchlist
- Dedicated Watchlist tab shows only your pinned items
- Persists across sessions

### ✈ Travel Profit Tracker
- Ranks all **11 destinations** by profit/hour in real time
- Accounts for **5% Torn sales tax**, your carry capacity, and YATA stock levels
- Click any destination for full trip breakdown — buy price, sell price, net after tax, effective carry, total profit, profit/hr
- Stock confidence badge — **YATA ✓** (live crowd-sourced) vs **~stock** (assumed full)
- Smart travel alerts — browser notification when top destination changes or improves 15%+

### ⚔ War Gear
- Full **ranked war weapon & armor calculator** — input damage, accuracy, armor rating, stealth, weapon exp, rarity, bonuses
- DPS score, overall score out of 100 with color-coded bar
- BB trade-in value + dollar equivalent per item
- **War gear price tracker** — monitors weapon/armor market prices with change % and BB value

### 🪙 Bunker Bucks Calculator
- Complete **BB trade-in reference table** for all rarities and weapon types
- Dollar values calculated at your current BB/$ rate (adjustable)
- **Cache costs table** with dollar equivalents
- **Grind estimator** — enter your avg BB per war and wars per week, get exact wars and weeks to your target cache
- Auto-fetches your current BB balance from the Torn API

### 💡 Quality of Life
- **First-time onboarding** — non-blocking slide-in wizard, auto-opens API settings page, auto-detects carry capacity
- **Session tracker bar** — live watched-item inventory estimate + session profit/loss
- **Data age indicator** — green/yellow/red dot showing how fresh your prices are
- **⬇ CSV export** — export any tab's data to clipboard or file
- **Alt+T keyboard shortcut** — toggle the panel from anywhere on Torn
- **Draggable FAB and panel** — position them anywhere, saved across sessions
- Moderate **inline tooltips** — hover ? icons for plain-English explanations of every signal and metric
- Uses your **TEEM elephant logo** as the FAB button icon

---

## 🚀 Installation

### Requirements
- [Tampermonkey](https://www.tampermonkey.net/) browser extension
- Works on **OperaGX, Chrome, Firefox, Edge** — any Chromium or Firefox browser with Tampermonkey

### Install via Gist (recommended — one click)
1. Go to the [TEEM Gist](https://gist.github.com/YOUR_USERNAME/YOUR_GIST_ID) *(update this link after uploading)*
2. Tampermonkey will automatically detect the `.user.js` file and show an **Install** button
3. Click Install

### Manual install
1. Open **Tampermonkey** → Dashboard → click the **+** tab
2. Select all the default template text and delete it
3. Paste the contents of `torn-market-tracker.user.js`
4. Hit **Save** (Ctrl+S)

---

## ⚙️ Setup

On first install, a small setup card will slide in from the bottom-left corner of your screen:

1. **Step 1 — API Key**: TEEM automatically opens your [Torn API settings](https://www.torn.com/preferences.php#tab=api) in a new tab. Create a **Limited** key with `Market`, `User`, and `Torn` access enabled. Paste it into the setup card.
2. **Step 2 — Carry Capacity**: TEEM attempts to auto-detect your carry capacity. If the number is wrong, type your actual value (check your in-game Travel page).
3. **Step 3 — Tab Tour**: Quick overview of all five tabs.
4. **Step 4 — You're ready**: Tips and keyboard shortcuts.

You can skip setup at any time and configure via **⚙** in the panel header.

---

## 🎮 Usage

| Action | How |
|---|---|
| Open/close panel | Click the 🐘 TEEM button, or press **Alt+T** |
| Move the TEEM button | Drag it anywhere — position is saved |
| Move the panel | Drag the header bar |
| Add to watchlist | Click any **WATCH** badge — it lights up gold |
| Export data | Click **⬇ CSV** in the top bar |
| Force refresh | Click **↻** in the panel header |
| Change timeframe | Click 1H / 6H / 1D / 3D / 1W / 2W / 1M buttons |
| Filter by category | Use the dropdown next to timeframe buttons |
| Set budget cap | Enter max price in the filter row |
| Change BB/$ rate | Adjust the $M/BB field in the 🪙 BB Calc tab |

---

## 📊 How Signals Work

| Signal | Meaning |
|---|---|
| 🔥 **BUY** | Price trending up 5%+ over selected timeframe |
| 🏅 **HOLD** | Mild upward movement — worth sitting on |
| 👁 **WATCH** | Volatile but no clear direction yet |
| 🧊 **SELL** | Price trending down 8%+ |

**Confidence dots** (● ● ●) show how much data backs the signal:
- ● ● ● — Strong trend, lots of snapshots
- ● ● ○ — Moderate confidence
- ● ○ ○ — Early signal, thin data (improves over time)

> **Note:** TEEM builds its own price history locally. Signals get significantly smarter after 24–48 hours of running. The longer it runs, the better the data.

---

## 🗺️ Travel Rankings

TEEM ranks all 11 destinations by **profit per hour** accounting for:
- Round-trip flight time
- In-country buy price
- Live Torn market sell price (after 5% tax)
- Your carry capacity
- YATA stock level (when available)

| Country | Primary Items | Flight (one-way) |
|---|---|---|
| 🇲🇽 Mexico | Jaguar Plushie, Dahlia | 18 min |
| 🇰🇾 Cayman Islands | Stingray Plushie, Banana Orchid | 25 min |
| 🇨🇦 Canada | Wolverine Plushie, Crocus | 29 min |
| 🌺 Hawaii | Orchid, Large Suitcase | 54 min |
| 🇬🇧 United Kingdom | Red Fox Plushie, Nessie Plushie, Heather | 111 min |
| 🇦🇷 Argentina | Monkey Plushie, Ceibo Flower, Tear Gas | 112 min |
| 🇨🇭 Switzerland | Chamois Plushie, Edelweiss, Flash Grenade | 123 min |
| 🇯🇵 Japan | Cherry Blossom, Xanax | 158 min |
| 🇨🇳 China | Panda Plushie, Peony | 169 min |
| 🇦🇪 UAE | Camel Plushie, Tribulus Omanense | 190 min |
| 🇿🇦 South Africa | Lion Plushie, African Violet, Xanax | 208 min |

---

## 🪙 Bunker Bucks Reference

BB trade-in values (community verified, Big Al's Bunker):

| Rarity | Pistol/SMG | Melee | Shotgun/Rifle | Armour | Heavies |
|---|---|---|---|---|---|
| Yellow | 4 | 6 | 10 | 12 | 14 |
| Orange ×1 | 12 | 18 | 30 | 26 | 42 |
| Orange ×2 | 18 | 27 | 45 | 26 | 63 |
| Red ×1 | 36 | 54 | 90 | 108 | 126 |
| Red ×2 | 54 | 81 | 135 | 108 | 189 |

---

## 🔒 Privacy & Security

- Your API key is stored **locally in your own browser** via Tampermonkey storage — it never leaves your machine except for direct calls to `api.torn.com` and `yata.life`
- Price history is stored **locally** — it doesn't sync anywhere or get shared with anyone
- No ads, no tracking, no external servers — TEEM only ever talks to Torn's official API and YATA
- The script identifies itself to Torn's API logs as `TEEM` via the `comment` parameter — this is standard practice and not personally identifying

---

## 📋 Changelog

### v3.0.5 — Current
- Fixed tooltip overflow — now appears below column headers instead of clipping off-screen

### v3.0.4
- Fixed onboarding step 4 to reference 🐘 TEEM button correctly

### v3.0.3
- Carry capacity step now fully editable with clear warning when auto-detect fails

### v3.0.2
- Onboarding changed from full-screen blocking modal to non-intrusive slide-in card
- Auto-opens Torn API settings page on first launch

### v3.0.0
- Full UX overhaul
- First-time onboarding wizard (4 steps)
- Auto-detect carry capacity from API
- Smart travel alerts (browser notifications)
- Session tracker bar — inventory estimate + session profit
- CSV export for all tabs
- Inline tooltips on signals and metrics
- Alt+T keyboard shortcut
- Data age indicator

### v2.2.0
- Travel tab completely rewritten with correct items (flowers + plushies, not just drugs)
- All travel times verified against community guides
- 5% Torn sales tax applied to profit calculations

### v2.1.0
- ✈ Travel tab integrated from standalone extension
- All 11 countries with correct items and verified travel times

### v2.0.0
- ⚔ War Gear tab — weapon/armor calculator + price tracker
- 🪙 BB Calculator tab — trade-in table, cache costs, grind estimator
- BB balance auto-fetched from API

### v1.x
- Market tracker, watchlist, hot/cold theme, YATA integration, v2 live pricing

---

## 🤝 Contributing

Found a bug? Item ID wrong? Travel time off? Open an issue or submit a pull request. Community data verification is especially welcome for:
- Travel item buy prices (these can shift)
- BB trade-in values if Torn updates them
- New country items if Torn adds destinations

---

## ⚠️ Disclaimer

TEEM is a fan-made tool and is not affiliated with or endorsed by Torn City or Chedburn Networks. Use it in accordance with [Torn's scripting rules](https://www.torn.com/forums.php#/p=threads&f=67&t=16066406). All market data is pulled from Torn's official API.

---

*Built with 💛 for the Torn community. May your markets be hot and your flights be profitable.*
