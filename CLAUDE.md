# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A single-file Tampermonkey userscript ([TornElephantEconomyManager.user.js](TornElephantEconomyManager.user.js)) for the Torn City browser game. There is no build system, no package manager, no tests — just one `.user.js` file (~3900 lines) that runs entirely inside the browser via Tampermonkey.

## Development workflow

1. Edit `TornElephantEconomyManager.user.js`
2. In Tampermonkey dashboard, open the script and paste the updated content (or set up a `@require file://` pointing to the local file)
3. Refresh any `https://www.torn.com/*` page to test

There is no linter, no formatter, and no test suite. Validate changes by running the script in-browser.

## Architecture

The entire script is one IIFE (`(function() { 'use strict'; try { ... } catch(e) {} })()`) — all state lives in module-level variables. Tampermonkey APIs used: `GM_setValue`, `GM_getValue`, `GM_addStyle`, `GM_xmlhttpRequest`.

### Persistence layer

`store(key, val)` / `load(key, def)` wrap `GM_setValue`/`GM_getValue` with JSON serialization. All storage keys are prefixed with `SCRIPT_KEY = 'tmit_'`. Key stored objects:

- `settings` — user preferences (API key, carry capacity, flight type, poll intervals, panel position, etc.)
- `priceHistory` — `{ [itemId]: [{ ts, price, yataPrice }, ...] }` — tiered compaction via `thinHistory()`
- `itemMeta` — `{ [itemId]: { name, type, market_value } }` — Torn item catalog, cached 6 hours
- `watchlist` — `Set` of pinned item IDs
- `playerCache` — spy/stat data keyed by player ID, 24h TTL, max 500 entries
- `myBattleStats`, `statHistory`, `warItemStats`, `quickItems` — battle/war tab data

### Data flow (poll cycle)

Each poll (default 60s) runs:
1. `fetchAllItems()` — Torn API `torn/items` (returns `{}` if cached metadata is still fresh within 6h)
2. `fetchYataPrices()` — YATA bazaar prices (parallel with step 1)
3. `resolveTravelItemIds()` — maps item names to IDs for travel calculations
4. `fetchLivePrices()` — live market listings for up to 15 priority items (watchlist + high-traffic + volatile)
5. YATA travel stock fetch
6. `appendHistory()` per item → `thinHistory()` compaction
7. `recomputeTravel()` + `renderList()` + tab re-renders

### Signal analysis (`analyzeItem`)

Uses local price history. Signals: **BUY** (>5% change + positive linear trend slope), **SELL** (<−8% + negative trend), **HOLD** (>2% change), **WATCH** (default). Confidence 1–3 dots based on magnitude. Big spike detection at ±15% and ±30%.

Price blending when both sources available: `tornPrice × 0.6 + yataPrice × 0.4`.

### External APIs

| Endpoint | Purpose |
|---|---|
| `api.torn.com/torn/?selections=items` | Item catalog + market_value (6h cache) |
| `api.torn.com/market/{id}?selections=itemmarket` | Live lowest 5 listings per item |
| `api.torn.com/user/?selections=...` | Battle stats, bars, cooldowns, inventory |
| `yata.life/api/v1/bazaar/abroad/` | YATA bazaar prices |
| `yata.life/api/v1/travel/export/` | YATA travel stock levels |
| `tornstats.com/api/v2/{key}/spy/user/{id}` | Spy data |

All requests go through `apiGet()` / `apiGetWithTimeout()` which use `GM_xmlhttpRequest` wrapped in a `Promise.race` with a hard 12s timeout.

### Travel profit model

`calcTravelProfit()` — for each country, finds the highest profit/hour item. Applies: 5% Torn sales tax, flight type multiplier (`economy=1.0`, `airstrip=0.7`, `business/wlt=0.5`), YATA stock level, and carry capacity cap. Rankings in `COUNTRIES` array use item names resolved to IDs at runtime via `travelItemIdMap`.

### History compaction (tiered thinning)

`HISTORY_TIERS` defines resolution by age: last 24h keeps every snapshot, 1–7d keeps one per hour, 7–30d one per 6h, 30d+ one per day. `thinHistory()` runs on every `appendHistory()` call and on startup via `thinAllHistory()`.

### UI

All CSS is injected as a single minified string via `GM_addStyle`. The panel is a fixed-position overlay with tabs: Market, Watchlist, Travel, War Gear, BB Calc, and Stats/Spy. Panel and FAB positions are draggable and saved to `settings`. The FAB is an elephant logo button toggled with **Alt+T**.

### War/BB data

`BB_TABLE` and `BB_CACHE_COSTS` are hardcoded lookup tables for Bunker Bucks trade-in values. `RW_KNOWN_WEAPONS` is a hardcoded Set of all ranked war weapon names (used as fallback when Torn API type strings are inconsistent). `classifyWeaponType()` normalises Torn API type strings to `Pistol/SMG`, `Melee`, `Shotgun/Rifle`, `Armour`, `Heavies`.

## Important constraints

- The script must remain a single self-contained `.user.js` file — no imports, no external dependencies beyond Tampermonkey's GM_* API.
- Travel times in `COUNTRIES` are one-way economy minutes; always use `getAdjustedTravelTime()` before displaying to the user.
- Item IDs in `ALWAYS_LIVE_IDS` are verified against the Torn API — don't change them without cross-checking the live API.
- `market_value` from Torn's catalog is only recorded to history if it changed since the last snapshot (prevents flat poisoned history for illiquid items).
- All GM storage keys must use the `SCRIPT_KEY` prefix to avoid collisions with other scripts.
