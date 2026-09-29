# Babyz Pizza revenue app — durable conventions

Vanilla-JS single-page app, no framework, no build step (Chart.js is vendored). Full history is in
the dated daily logs; this file is only the rules that must not be broken.

## Editing is local-only — never weaken this
* `canWrite()` = `isLocalContext() && (mode === 'server' || mode === 'draft')`. **One gate** for every
  mutation. Never add a second, independent "is live?" check.
* `isLocalContext()` is a strict allowlist: `file://`, `localhost`, `127.x.x.x`, `0.0.0.0`, `::1`,
  `*.localhost`. **No query-string escape hatch** — a `?local=1` switch would let a hosted URL
  re-enable editing.
* Any new editing UI needs **both** `.readonly-hide` (cosmetic) **and** `if (!guardWrite()) return;`
  (the real protection). The CSS alone protects nothing.
* `body.is-live` / `body.is-readonly` are both set from `!canWrite()`; keep them in sync.
* `server.js` sends CORS headers only to `Origin: null` or a loopback origin, and binds `127.0.0.1`.
* Test visibility with `el.getClientRects().length`, **never** `getComputedStyle(el).display` — a
  child of a `display:none` parent still reports its own display, so that method counts hidden buttons.

## Two state copies — mutate both or the save silently no-ops
`state.base` is what is written to the files; `state.data` is what renders. Menu edits go through
`menuApply(fn)`. Every mutation must push a **fresh object per copy** (never share a reference).
Getting this wrong repaints the UI while saving nothing, and `renderAll()` only runs on `res.ok`, so
the screen looks healthy.

## The three data files
| file | role |
|---|---|
| `<Desktop>\Babyz Pizza Data\babyz-data.js` | MAIN (backup) |
| `<Desktop>\Babyz Pizza Data\babyz-data-pending.js` | STAGE (staged deletions) |
| `<repo>\data\babyz-data.js` | REPO — the site reads this; the one you commit |

The app **loads the REPO first** (`readData(REPO_FILE) || readData(MAIN_FILE) || …`), so the repo is
the live copy and the Desktop pair can lag behind it.
Add → all 3. **Edit** → all 3 (same `/api/rows` path). Delete → STAGE only; **Confirm delete** pushes
STAGE → MAIN + REPO. Undo re-reads MAIN. Format is `window.BABYZ_DATA = {…}` **JS, not JSON** (a
`<script src>` works over `file://`; `fetch()` of JSON is CORS-blocked there).

**`/api/rows` must never write `body.view` straight to STAGE.** `view` is `state.data` = base *minus*
the rows staged for deletion. Writing it to STAGE drops those rows while `pendingDeletes` still lists
them, so a later **Confirm delete** finalises them and `/api/undo` can no longer bring them back.
`server.js` rebuilds STAGE with `mergeView(base, view)`. Any future save path must do the same.

**`BABYZ_DESKTOP_DIR` redirects MAIN/STAGE only — `REPO_FILE` is always `path.join(__dirname,'data',…)`.**
A sandboxed server therefore still writes the real repo file. Point a sandbox at a throwaway clone of
the repo, or expect `data/babyz-data.js` to change under you.

## An order is ONE row with many `lines` — never multiply the summary fields
`lines: [{ item, qty, price }]`; `rowLines(row, kind)` is the **only** reader (returns `row.lines`,
else synthesises one line from the old flat fields, so pre-`lines` rows need no migration).

**The trap:** `item` / `qty` / `sellingPrice`(or `rate`) stay on the row as a *summary* — `qty` is the
**total units**, `sellingPrice` the **first line's** price. So `sellingPrice × qty` is **not** the
order's value once there is more than one pizza. Every money figure comes from the lines.
`offlineRows` / `swiggyRows` compute `amount`/`gross`/`final`/`cost` and every KPI, chart and table
reads those, so those two are the single choke point. **Never reintroduce a price×qty product** (the
full set was fixed in `describeRow`, `offlineRows`, `swiggyRows`, `invoiceModel`).

Everything that reads an item is line-aware: `pass()` matches when **any** line matches
(`row.lineItems` / `row.lineCats`) and the haystack joins all line items; item charts aggregate per
line; the category doughnuts attribute **per line** (that is what puts a mixed veg/non-veg order in
both slices). The offline **offer belongs to the order**, so the doughnut spreads it across lines *in
proportion to their value*, keeping its total equal to the sum of the orders' `final`.

The table stacks when >1 line (`itemsCell`) and prints **varies** when the lines disagree
(`priceCell`). The invoice already loops `m.items` and tightens its row pitch past 6 lines.

**The lines editor is one reusable repeater** — `renderLinesEditor` / `wireLinesEditor` /
`readLinesEditor` / `snapshotLines`, all keyed off the same `.lines-editor` root, driving both add
panels and the ✏️ Items modal so they cannot drift. `readLinesEditor` validates and names the
offending row; `snapshotLines` reads *without* validating, to carry a half-typed order across a
dropdown rebuild. `itemSelectHtml` re-adds an **off-menu item** so opening the editor on an order
whose item was deleted cannot silently change what was sold. `renderFilters` rebuilds the add-panel
editors only when `JSON.stringify(state.data.menus)` changes — never on every `renderAll()`, which
would wipe a half-typed order.

## Row editing — pencils live IN the cell they edit
`actionsCell(collection, id)` renders only **🧾 Invoice** (reads only, so it works everywhere) and
**Delete** (`readonly-hide`). Every other control is a **pencil inside the cell holding the value**:
`customerCell()` / `orderNoCell()` / `itemCell()`, built from `cellEdit(value, pencil)` and
`pencil(attrs, title)`. That is what stops a row stretching: the Actions column went 461 → 167px and
the Swiggy table 1711 → 1487px. **Do not add another text button to `actionsCell`.**

`actionsCell` is used **only by the Swiggy and Offline tables** — payouts and investments build their
action cells inline, so new controls for those go there. The investments pencil stays in its Actions
cell because that editor changes three adjacent columns (Qty/Rate/Amount) at once.

Handlers are **delegated on `document`** in `wireEvents()`, keyed off `data-edit-customer` /
`data-edit-lines` / `data-edit-order-no` / `data-edit-investment` / `data-del` / `data-invoice`.
Renaming a customer is allowed on `offlineOrders` and `swiggyOrders` only.

**Every row editor follows the same shape** (`requestXEdit` → `applyXEdit`): open a popup, validate,
mutate **both** state copies pushing a fresh object per copy, then `writeAll(msg)` — the same
`/api/rows` path an add uses — then `renderAll()` and a ✅ confirmation popup. Reuse it.
* **Investments** — qty/rate/amount together. **The amount follows `qty × rate` only until the user
  types in the amount field** (`amountTyped`); after that qty/rate must not overwrite it. The
  `.modal-hint` line always states which rule is in force.
* **Order no.** — `#` + exactly 4 digits, stored **WITHOUT the hash** (`orderNo: "1234"`). The `#` is
  added back only at the display points: table cell, search haystack, `invoiceRef`, invoice line.
  Blank is valid and removes it. Add field and row editor share one `normalizeOrderNo`.
* `openModal` must reset `modalOk.disabled`, or cancelling an editor whose confirm was disabled leaves
  **every later popup** with a dead confirm button.

## Swiggy weeks
`weekPeriods()` is the single source: recorded payout ranges first (authoritative, including merged),
then the 7-day grid anchored at 1 Sep 2026 (1–5 Sep is the short first block), then calendar weeks
clipped at 31 Aug. Nothing is hardcoded. The offline weekly chart intentionally still uses plain
Sunday→Saturday calendar weeks.

`payoutWeekEnd(start)` = **start + 6**, with one exception: `2026-09-01` → `2026-09-05` (the short
first week). That exception is **load-bearing** — `gridWeekOf()` walks the whole grid off it, so
changing it re-buckets every order in the app. Do not touch it; let the user override the ending in
the form instead.

**The week ending is editable on the add panel.** `#swpEnd` is a real `<input type="date">` (it used
to be a read-only `.computed` label). `updatePayoutEnd()` keeps it in step with the start day via
`dataset.auto`, which remembers the last value *we* wrote: a start change re-fills the ending **only
while it still equals that value**, so a date the user chose is never silently overwritten — the same
shape as the investment editor's `amountTyped` flag. Clearing the field re-fills the default. The
ending must be `>= start` (the input's `min` blocks the picker, the label turns red, submit refuses).
`payoutRange(p)` already preferred an explicit `p.weekEnd`, so the whole read path — `payoutRows`,
`weekPeriods`, the merge logic, the `· Nd` in the table — needed no change at all. Note the label's
live day count lives in the **label**, not under the input: `.add-grid` is `align-items:end`, so
anything taller than an input breaks the row's alignment.

## Menus
The menu is the **source of truth for an item's category** (`resolveCategory`), so moving an item
between groups re-colours its badges and re-slices the doughnut. A **deleted** item falls back to the
category stored on the order, so history never breaks. `legacy` items keep a `category`.

## The invoice
`invStamp(row.date)` prints `Generated <order date>` — **the order's own date, never today's**. An
order records a date but never a time, so no clock time is printed; it reuses `dNice()` so the stamp
reads exactly like the invoice's own `Date` field. The invoice draws only **after**
`withInvoiceLogo()` resolves (`assets/logo.js` sets `window.BABYZ_LOGO`, then `new Image().onload`) —
anything testing it must satisfy that or it never draws.

## Table layout — headers wrap, data cells do not
`.wrap` is `max-width:1500px` with 24px padding and `.card` adds ~18px, so a table's container is
**1416px**. Every `tbody td` is `white-space: nowrap` on purpose, so the header labels also
contribute to the table's minimum width. `thead th` is therefore `white-space: normal` with
`padding: 10px 9px` (`tbody td` / `tfoot td` use 9px too). **Both halves were needed** — measured by
reverting each in isolation, the Swiggy table's 71px overflow was **66px of horizontal padding**
(12px → 9px) plus **39px of header labels** ("Selling price", "Order no."); the headers alone are
worth only 39px, the padding alone 66px. After the fix: Swiggy min-content **1382px** in 1416 →
**34px headroom**; Offline **1209px** → **207px**. The two-word headers wrap to two lines, taking the
header row 37 → 53px — that is the intended trade. **Do not "tidy" `thead th` back to `nowrap`:**
that alone puts Swiggy 5px over and drops its headroom to −5px.

## The write path — `writeAtomic` must never strand a `.tmp`
Every save goes through `writeAtomic(file, text)`: write `<file>.tmp`, then rename over the target.
**On Windows `rename` over an existing file needs DELETE access**, so it fails `EPERM` whenever
something holds the file open sharing read+write but not delete — an editor with the file in a buffer
(**Zed on this machine**), OneDrive, antivirus, the Explorer preview pane. A plain write only needs
WRITE, which is why the fallback exists: (1) write the `.tmp`; (2) `renameSync` up to 6× with backoff
and `chmod 0o666` on both files between attempts; (3) **still refused → `writeFileSync(file, text)` in
place**, then drop the `.tmp`; (4) only if that also fails, throw naming the file, the code and the
likely holders. Never simplify back to a bare write+rename: the old version failed the save and left
the new data orphaned in `babyz-data.js.tmp` — how 7 offline orders were nearly lost on 27 Sep 2026.
The read-only attribute is **not** the usual cause (that incident showed `Attributes: Archive`,
`IsReadOnly: False`); to name the holder use the Restart Manager API (`rstrtmgr.dll`) — it returned
`pid=13880 app=Zed`. A failed write must be **loud**: the client shows it in the modal via
`saveFailed(what, res)`, never a toast.

**There is no conflict detection.** `writeAll` posts `state.base` wholesale, so a save from a stale tab
silently overwrites newer on-disk data. After changing the data files behind the app's back, tell the
user to **reload** before saving.

## Gotchas that have already bitten
* `baseOpts(extra)` is a **shallow** `Object.assign` — passing `plugins` replaces the whole default
  plugins object and silently drops the legend styling. Re-declare `legend` when you override it.
* A `<canvas>` has no DOM children — read chart state via `Chart.getChart(el)`.
* The app hardcodes `API_BASE = http://127.0.0.1:8787`, so a test server on another port makes the
  page fall back to **draft** mode. Use 8787 for a faithful capture.
* `assets/logo.js` must be copied into any test sandbox or the invoice 404s (harmless — the drawn mark
  is the fallback — but it shows as a console error).
* Verify writes against the **files/API**, not just the DOM.
