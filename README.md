# 🍕 Babyz Pizza — Revenue & Order Tracker

A single-page web app for the Babyz Pizza cloud kitchen (Garia, Kolkata) that tracks
**Swiggy** and **offline** orders separately, calculates revenue and approx. profit,
and keeps everything invested in one place.

Created by **Rounak Adhikary**.

---

## The three data files

| # | File | Where | Role |
|---|---|---|---|
| 1 | `Babyz Pizza Data/babyz-data.js` | your **Desktop** | **MAIN** — the real local copy |
| 2 | `Babyz Pizza Data/babyz-data-pending.js` | your **Desktop** | **2nd local copy** — deletions land here first |
| 3 | `data/babyz-data.js` | inside this **repo** | **REPO copy** — the site always *reads* this, and it's the one you commit |

### What happens on each action

| Action | MAIN | 2nd copy | REPO |
|---|---|---|---|
| **Add a row** | ✅ written | ✅ written | ✅ written |
| **Delete a row** | ❌ untouched | ✅ written | ❌ untouched |
| **Undo deletes** | read | rebuilt from MAIN | ❌ untouched |
| **Confirm delete** | ✅ written | cleared | ✅ written |

**Every figure the page shows is read from the REPO copy.** On the hosted site the repo
copy is the only source; locally the writer serves the same repo copy through
`/api/state`. The only exception is *Undo deletes*, which by design re-reads the
**main local file** — exactly as intended.

---

## Everyday workflow

1. Double-click **`start-local.bat`** (or run `node server.js`) → `http://localhost:8787`.
2. **Add** orders freely — each one is written to all three files at once.
3. **Delete** a row → a popup asks *"Are you sure you want to delete this row?"*.
   Confirming removes it from the **2nd local copy only**.
   A bar appears at the bottom of the screen showing how many rows are staged.
4. **↩ Undo deletes** — restores everything from the main local file.
5. **✅ Confirm delete** — popup asks once more, then pushes every staged deletion into
   the **main local file** and the **repo copy**.
6. Commit & push from GitHub Desktop / your IDE:

   ```bash
   git add data/babyz-data.js
   git commit -m "Update Babyz data"
   git push
   ```

7. Reload the hosted site — it reads the freshly pushed repo copy.

> There are deliberately **no commit/push buttons** on the website.

---

## Hosting on GitHub Pages (free)

1. Push this folder to a GitHub repository (public).
2. **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.
3. The site goes live at `https://<username>.github.io/<repo>/`.

On the live site the badge reads **LIVE · READ ONLY**: every table, chart, filter and
trend works, but no add/delete control is rendered anywhere.

### Editing is local-only

Nothing can be added or deleted from a hosted copy — not data rows, not menu items, not
settings. The rule is enforced in three independent places, so no single mistake re-opens it:

| Layer | What it does |
|---|---|
| **Origin allowlist** (`isLocalContext`) | Only `file://` and loopback hosts (`localhost`, `127.x.x.x`, `::1`, `*.localhost`) count as local. There is deliberately **no `?local=1` query switch** — that would let a hosted URL turn its own editing back on. |
| **Single write gate** (`canWrite` / `guardWrite`) | Every mutation funnels through one check, evaluated live rather than cached at boot. It gates row adds, all row deletes, all three menu operations, staged delete, confirm, undo, settings, and every file write. |
| **Server origin check** | The writer only returns CORS headers to `Origin: null` (a `file://` page) or a loopback origin. Anything else gets `403` on both the preflight and the request, so a website you happen to have open cannot post to your data files even while the writer is running. |

The read-only class is driven by the gate itself (`body.is-live` / `body.is-readonly`), so if a
page cannot write, the controls are hidden *by construction* rather than by a separate rule that
could drift out of sync. The writer also binds to `127.0.0.1` only, so it is not reachable from
the LAN.

### Opening `index.html` directly from disk

If you double-click `index.html` while the local writer is running, the page still
detects it and writes to the data files. If the writer is **not** running, the app falls
back to **draft mode** — rows and staged deletions are kept in that browser only, and
you'll see a warning banner. Start `start-local.bat` to switch back to real file saving.

---

## What's inside

| Tab | Contents |
|---|---|
| **🛵 Swiggy** | KPIs, weekly gross-vs-payout chart, deduction %, daily sales, item popularity, veg/non-veg/combo split, master order table, weekly payout table |
| **🏪 Offline** | KPIs, daily & weekly revenue, profit, item popularity, category split, cumulative revenue, master order table |
| **💰 Money Earned** | combined revenue, investment tracking, cumulative investment-vs-revenue, profit by channel, investment by category, ₹/pizza cost setting |
| **📋 Menus** | the offline and Swiggy menus, grouped into Veg / Non-Veg / Combo / Legacy — add, delete and move items right here |

All data tabs have filters for **date range, menu item, veg / non-veg / combos** and
free-text search. Every date-wise chart regenerates from the data on load, so adding a
row with a brand-new date immediately creates the new axis point (and a new Swiggy week
if needed).

---

## Editing the menus

The **📋 Menus** tab is not just a reference — it's where the menu is maintained. Each channel
has its own card with an **➕ Add a menu item** panel and a **Move** / **✕** pair on every row.

| Action | What happens |
|---|---|
| **Add** | pick name, price and group → confirm popup → saved to all 3 files |
| **Move** | confirm popup with a *Move to* picker → the item lands in Veg / Non-Veg / Combo / **Legacy** |
| **Delete** | confirm popup → removed from the menu and saved to all 3 files |

* **Every action asks first.** Nothing is written until you press the confirm button in the popup.
* **Duplicate names are rejected** — the same item can't sit in two groups on one channel.
* **Legacy is a real destination, not a graveyard.** Moving an item there keeps it selectable in
  the item dropdowns (so you can still record an order for it) while taking it off the live menu.
  Legacy items remember the group they came from, so their orders keep the right category.
* **Adding straight to Legacy** asks for a *Kept as* category for exactly that reason.
* **Deleting an item that has orders warns you first**, and tells you how many orders use it.
  Those orders keep their name and category, so no history is lost — but the item drops out of
  the dropdowns. *Move to Legacy* is the non-destructive alternative.

**Everything refreshes automatically.** After any add, move or delete the page re-renders in one
pass — the menu lists, both item dropdowns (filters *and* the add-order forms), the order-table
category badges, and the item / category charts. The menu is treated as the source of truth for an
item's category, so moving an item between groups re-colours its badges and re-slices the
Veg / Non-Veg / Combo doughnut. An item that was **deleted** falls back to the category stored on
the order itself, so old records never break.

Menu editing is hidden on the hosted site along with every other write control.

---

## How the money is calculated

**Offline**

```
amount       = rate × qty
final        = amount − offer amount
food cost    = ₹80 × qty          (configurable in Money Earned → Revenue settings)
profit       = final − food cost
```

**Swiggy**

```
gross sales  = selling price × qty        (what the customer paid)
revenue      = weekly payout you record   (Swiggy's commission is already deducted)
deducted     = gross sales of that week − payout
deducted %   = deducted ÷ gross sales × 100
```

**Combined**

```
money earned = offline revenue + Swiggy payouts
net position = money earned − total invested
```

### Swiggy payout weeks

The payout week is **not hardcoded**. In the weekly payout add-panel you pick the
**week start day** from a calendar and the **end day is derived automatically**:

```
week end = start + 6 days        → a 7-day week
```

One exception, because Swiggy's very first payout window was short:

| Start day you pick | Auto end day | Days |
|---|---|---|
| **1 Sep 2026** | 5 Sep 2026 | 5 |
| any other day | start + 6 days | 7 |

* Dates **before 1 Sep 2026 are disabled** in the calendar — the payout history starts there.
* Picking a start day fills the read-only *Week ends (auto)* field instantly, so you always
  see the window before you save.

**Overlapping weeks merge.** If the range you pick touches or overlaps a week you already
recorded, the two are **combined into a single row**: the payout amounts are summed and the
range becomes the union of both. So 20 Sep (20–26) followed by 22 Sep (22–28) produces one
row covering **20 Sep → 28 Sep** with the payouts added together, flagged `merged ×2`. A
later 10 Sep entry (10–16) absorbs both the 6–12 and 13–19 weeks into `6 Sep → 19 Sep`.
Deleting a merged week removes the whole merged row, and **↩ Undo deletes** brings it back
intact — same merge rules apply on both add and delete.

### Where the weeks come from

**Nothing about weeks is hardcoded.** `weekPeriods()` in `assets/app.js` builds one
contiguous, sorted list of weeks:

1. **Recorded payout ranges come first** — they are authoritative, including merged ones.
2. Any record the payouts don't cover falls back to the **7-day grid anchored at 1 Sep 2026**
   (1–5 Sep, then 6–12, 13–19, 20–26, 27 Sep–3 Oct, …).
3. Records dated **before 1 Sep 2026** use the plain calendar week, clipped at 31 Aug so it
   can never swallow the 1–5 Sep week.
4. Weeks with no activity are kept, so a quiet week reads as an empty slot, not a gap.

Add **N payout rows and N weeks appear** across every weekly view automatically:

| Where | What it shows |
|---|---|
| **Weekly gross sales vs payout received** | one bar pair per recorded week |
| **Deduction % per week** | only weeks that have gross sales — a payout with no recorded orders is skipped rather than plotted as a misleading 0 % |
| **Revenue by channel over time** (Money tab) | the same week axis, with offline revenue and investments bucketed into the week that contains them and each Swiggy payout placed by its start day |
| **Swiggy orders → Payout week column** | an orange badge when the order falls in a **recorded** payout week, a grey badge when the week is only **derived** from the 7-day grid, and `—` for dates before 1 Sep 2026 |

The **offline** weekly chart still uses plain Sunday → Saturday calendar weeks, because
offline orders have no payout cycle to follow.

---

## Source data

Seeded from `Babyz Financials.xlsx`:

* **Purchases** sheet → 59 investment / purchase rows (₹9,651 total outflow)
* **Sales** sheet → 17 offline orders (₹3,180 revenue) and 10 Swiggy orders
  (₹2,880 gross, ₹993.60 received in payouts)
* Totals reconcile with the workbook's Summary sheet: inflow ₹4,173.60, outflow ₹9,651.

Item names come from the menu screenshots (`Offline-menu (1–5).png`,
`Online Menu Swiggy (1–3).jpg`). Historical orders that used older item names
(e.g. *Countryside Veggies*, *All rounder combo*) are kept under a **Legacy** group so
nothing is lost and nothing is mixed up between channels.

---

## Files

```
index.html              the app
assets/styles.css       theme (white / orange, deep green + red accents)
assets/app.js           all logic: data, filters, charts, tables, staged deletion
vendor/chart.umd.min.js Chart.js (bundled, works offline)
data/babyz-data.js      ▶ the repo copy — commit this
server.js               local writer (zero dependencies)
start-local.bat         Windows launcher
```

### Custom paths

```bat
set BABYZ_PORT=8788
set BABYZ_DESKTOP_DIR=D:\Babyz\data
node server.js
```
