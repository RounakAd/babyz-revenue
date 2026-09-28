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

### If a save fails

Each file is written by first saving `<name>.js.tmp`, then renaming it over the real
file. On Windows a rename needs **delete** permission on the target, so it is refused
while another program holds that file open — an editor with it in a buffer (Zed,
VS Code), OneDrive syncing, an antivirus scan, or the Explorer preview pane. The
refusal shows up as `EPERM`.

The writer handles this in three steps, so a locked file no longer costs you a save:

1. it retries the rename a few times, clearing a read-only attribute if one is set;
2. if the rename is still refused it **writes the file in place instead** — a plain
   write only needs write permission, which the lock allows — and logs
   `[write] rename blocked (EPERM) — wrote … in place instead`;
3. only if *both* fail does the save report an error, in a popup that stays on screen
   naming the file and the likely culprit. Nothing is lost in that case: the new data
   is sitting in the `.tmp` file beside the real one.

> If saving ever does fail, **close the program holding the file** (most often an
> editor with `babyz-data.js` open) and save again.

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
| **🛵 Swiggy** | KPIs, weekly gross-vs-payout chart, deduction %, daily sales, item popularity, veg/non-veg/combo split, master order table (with order numbers + per-order invoices), weekly payout table |
| **🏪 Offline** | KPIs, daily & weekly revenue, profit, item popularity, category split, cumulative revenue, master order table (with per-order invoices) |
| **💰 Money Earned** | combined revenue, investment tracking, cumulative investment-vs-revenue, profit by channel, investment by category, ₹/pizza cost setting |
| **📋 Menus** | the offline and Swiggy menus, grouped into Veg / Non-Veg / Combo / Legacy — add, delete and move items right here |

All data tabs have filters for **date range, menu item, veg / non-veg / combos** and
free-text search. Every date-wise chart regenerates from the data on load, so adding a
row with a brand-new date immediately creates the new axis point (and a new Swiggy week
if needed).

---

## Editing a row (local only)

Every table row carries its own actions in the **Actions** column. All of the editing
buttons are hidden on the hosted site — they only appear when the page is open locally
with the writer running.

| Button | Where | What it does |
|---|---|---|
| **🧾 Invoice** | every table | previews the order as an invoice; reads only, so it works everywhere |
| **✏️ Items** | Swiggy + Offline orders | adds, changes or removes the pizzas on that order |
| **✏️ Order no.** | Swiggy orders | adds or changes that order's `#XXXX` reference |
| **✏️ Customer** | Swiggy + Offline orders | renames the customer on that order |
| **✏️ Edit** | Investments | changes **Qty**, **Rate** and **Amount** on that purchase |
| **Delete** | every table | stages the row for deletion (see the workflow above) |

Every editor saves the same way: the corrected row goes to the **main local file**, the
**2nd local copy** and the **repo copy** in one go, then every table, total and chart
refreshes. Commit & push the repo copy to publish the change.

### Ordering more than one pizza

An order can hold **as many pizzas as the customer actually ordered** — both when you
record a new one and when you correct an existing one.

* The **➕ Add a Swiggy order** and **➕ Add an offline order** panels have a **Pizzas on
  this order** block instead of a single item/price/qty row. Each line is a menu item, a
  price and a quantity; **➕ Add another pizza** adds a line and **✕** removes one. The
  running total under the block shows how many pizzas, how many units and what they come to.
* **✏️ Items** on any order row opens the very same editor, pre-filled with that order's
  pizzas — so you can add a forgotten pizza, fix a price or drop a line later.
* Picking an item fills in the menu price; you can still type the exact amount charged.
* Each pizza is stored as its own line (`lines: [{ item, qty, price }]`) on **one** row, so
  an order stays one order. The table's **Item** column lists them stacked, **Qty** is the
  total units and **Gross**/**Amount** is the sum. When the pizzas were priced differently
  the **Selling price** / **Rate** column reads **varies** rather than pretending otherwise.
* **The invoice prints one line per pizza** — a proper multi-line bill, with the subtotal
  and total for the whole order.
* **Charts follow the pizzas, not the order.** Each pizza adds to its own bar in *Most
  popular items*, and to its own slice of the *Veg / Non-Veg / Combo* doughnut — so an order
  with one veg and one non-veg pizza lands in both.
* **Filters match any pizza on the order**, so searching or filtering by the second pizza
  still finds the order.
* The **offer amount** on an offline order applies to the **whole order**, not to one pizza.
* **Nothing already recorded changes.** Orders saved before this feature have no `lines`
  array and are read as a single pizza exactly as before — the table shows them just as it
  always did, with no stacked list and no "varies".

### Editing an investment

**✏️ Edit** opens a popup with the three figures side by side:

* **Amount follows `qty × rate`** — change either and the amount updates with it.
* **Type an amount yourself and it sticks.** From then on the amount is left alone,
  so a deliberate figure is never silently overwritten by a later qty/rate tweak.
  The note under the fields tells you when the amount no longer equals `qty × rate`,
  and shows what that product would be.
* The **Save figures** button stays disabled until all three fields hold a valid,
  non-negative number, so a typo can never reach the files.

Swiggy weekly payouts are **not** editable — they have no customer, qty or rate to
correct. Change those in the source data and re-import.

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
pass — the menu lists, both item dropdowns (filters *and* the pizza lines in the add-order forms),
the order-table category badges, and the item / category charts. A **half-typed order survives**
that refresh, so adding a menu item mid-way through recording an order doesn't lose your work.
The menu is treated as the source of truth for an
item's category, so moving an item between groups re-colours its badges and re-slices the
Veg / Non-Veg / Combo doughnut. An item that was **deleted** falls back to the category stored on
the order itself, so old records never break.

Menu editing is hidden on the hosted site along with every other write control.

---

## How the money is calculated

For an order with a **single pizza** these are exactly the same as they always were. For an
order with several, each pizza's `price × qty` is worked out on its own and then added up —
so the table, the KPIs and the charts always agree with the invoice.

**Offline**

```
amount       = Σ (line price × line qty)   over every pizza on the order
final        = amount − offer amount       (the offer belongs to the whole order)
food cost    = ₹80 × Σ line qty            (configurable in Money Earned → Revenue settings)
profit       = final − food cost
```

**Swiggy**

```
gross sales  = Σ (line price × line qty)   over every pizza on the order — what the customer paid
revenue      = weekly payout you record    (Swiggy's commission is already deducted)
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

## Order numbers & invoices

### Optional order number — `#XXXX` (Swiggy orders, local only)

A Swiggy order can carry an optional reference, always shown as **`#` followed by exactly
four digits** — `#1234`, `#0042`. You can type it either way: `1234` and `#1234` are both
accepted, and it is stored on the row as `orderNo` **without** the hash (the hash is added
back for display).

There are two ways to set it:

| Where | How |
|---|---|
| **Add panel** | the **Order no.** field next to the date when recording an order |
| **Existing row** | the **✏️ Order no.** button in the Actions column of any Swiggy order |

Both do the same thing, and both are **optional** — leave the field blank and nothing
changes. Anything that is not four digits is refused with a toast; in the row editor the
**Save** button stays disabled until the value is valid, so a bad number can never reach
the files.

Clearing the field removes the number from that order (the column then shows `—`).

The value is written to all three data files like any other field, appears in the Swiggy
master table **Order no.** column, is printed as **Order no.** on that order's invoice, and
is searchable from the *Search customer / item* box — type `1234` or `#1234` and the table
filters to it.

Both inputs live behind `.readonly-hide` and re-check the write gate, so they are
unavailable on the hosted copy by construction.

### Invoice per order — PDF and PNG

Every row of the **Swiggy** and **Offline** master tables has a **🧾 Invoice** button.
It opens a preview of a one-page A4 invoice built from that order's own data, with two
downloads:

| Button | What you get |
|---|---|
| **⬇ Download PDF** | `Babyz-Pizza-Invoice-<ref>.pdf` — the invoice on a single A4 page |
| **⬇ Download PNG** | `Babyz-Pizza-Invoice-<ref>.png` — the same invoice as an image |

`<ref>` is the order number you typed, or the row id when there isn't one, so an invoice
files itself next to the order it belongs to.

The invoice carries every detail of the order: bill ref / order no., date, customer,
channel, type, quantity, the item with its unit price and line amount, subtotal, discount
(when an offer was given), the total paid and the note. It opens with the **Babyz Pizza
logo** (see *The invoice logo* under **Files**) over the typeset business name and location,
and closes with the thank-you line and a **Code 39 barcode** of the reference, like the
receipt it is modelled on.

The Swiggy payout week is **not** printed on the invoice — it is a weekly settlement
figure, not something that belongs on a single customer's bill. It stays where it is
useful, in the Swiggy tab's payout week badge and the weekly payout table.

**It is not an editing control.** The button reads the row it already has, writes nothing
and needs no file access, so it stays available on the **hosted, read-only copy** — only
*Delete* is hidden there. Nothing is fetched from a CDN either: the invoice is drawn
straight onto a `<canvas>` (at 2× for print), the PNG is that canvas, and the PDF is
assembled byte by byte in `assets/app.js` (`pdfFromCanvas`) around the same JPEG. So it
behaves identically on GitHub Pages, on `localhost` and on `file://`.

Approx. food cost and profit are deliberately **not** printed — they are internal numbers
from the Money Earned tab, not something an invoice handed to a customer should carry.

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
index.html                  the app
assets/styles.css           theme (white / orange, deep green + red accents)
assets/app.js               all logic: data, filters, charts, tables, staged deletion, invoices
assets/logo.js              the invoice logo, embedded as a base64 data URI (generated)
vendor/chart.umd.min.js     Chart.js (bundled, works offline)
data/babyz-data.js          ▶ the repo copy — commit this
server.js                   local writer (zero dependencies)
start-local.bat             Windows launcher
tools/make-logo.js          rebuilds assets/logo.js from a source PNG (zero dependencies)
```

### The invoice logo

The invoice prints the Babyz Pizza logo from `assets/logo.js`, which holds it as a
**base64 data URI** rather than pointing at a `.png` file. That is deliberate:

* the invoice is drawn on a `<canvas>`, and the PNG/PDF downloads read that canvas
  back with `toDataURL()`;
* in Chrome and Edge a page opened from disk (`file://`) treats a linked image as
  cross-origin, which would **taint** the canvas and make every download fail with
  *"Tainted canvases may not be exported"*;
* a data URI is treated as same-origin, so the canvas stays clean on `file://`,
  on `localhost` and on GitHub Pages alike — and nothing extra is fetched.

Because a data URI ships with the page, the artwork is downscaled first: the
1254×1254 source becomes a 384×384 greyscale PNG (54 KB) and that becomes a 72 KB
URI. It is also loaded **lazily** — the dashboard does not fetch it at all; it
arrives the first time you open an invoice (and if the file is missing, the invoice
quietly falls back to the drawn mark instead of breaking).

**To change the logo**, drop the new image in the project folder and run:

```bash
node tools/make-logo.js my-new-logo.png        # 384 px, the default
node tools/make-logo.js my-new-logo.png 512    # or any edge size you want
```

The tool is zero-dependency — its own PNG decoder, area-average resampler,
greyscale detector and encoder, using Node's `zlib` for compression. It prints the
size it produced so you can trade sharpness against page weight.

### Custom paths

```bat
set BABYZ_PORT=8788
set BABYZ_DESKTOP_DIR=D:\Babyz\data
node server.js
```
